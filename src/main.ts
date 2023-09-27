import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import slugify from "@sindresorhus/slugify";
import * as yaml from "js-yaml";

interface TeamData {
  team_name: string;
  members: string[];
  team_sync_ignored?: boolean;
  description: string | undefined;
  parent: string | undefined;
}

async function run(): Promise<void> {
  try {
    const token = core.getInput("repo-token", { required: true });
    const teamDataPath = core.getInput("team-data-path");
    const teamNamePrefix = core.getInput("prefix-teams-with");

    const client = new github.GitHub(token);
    const org = github.context.repo.owner;

    core.debug("Fetching authenticated user");
    const authenticatedUserResponse = await client.users.getAuthenticated();
    const authenticatedUser = authenticatedUserResponse.data.login;
    core.debug(`GitHub client is authenticated as ${authenticatedUser}`);

    core.debug(`Fetching team data from ${teamDataPath}`);
    const teamDataContent = await fetchContent(client, teamDataPath);

    core.debug(`raw teams config:\n${teamDataContent}`);

    const teams = parseTeamData(teamDataContent, teamNamePrefix);

    core.debug(`Parsed teams configuration into this mapping of team names to team data: ${JSON.stringify(teams)}`);

    // Only manage the active teams
    const activeTeams = teams.filter((team) => !team.team_sync_ignored);

    // Now sync all of the existing teams
    await synchronizeTeamData(client, org, authenticatedUser, activeTeams);
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.error(String(error));
      core.setFailed(error.message);
    }
  }
}

async function synchronizeTeamData(
  client: github.GitHub,
  org: string,
  authenticatedUser: string,
  teams: TeamData[],
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax
  for (const teamData of teams) {
    const teamName = teamData.team_name;
    const teamSlug = slugify(teamName, { decamelize: false });

    const { description, members: desiredMembers, parent } = teamData;

    core.debug(`Desired team members for team slug ${teamSlug}:`);
    core.debug(JSON.stringify(desiredMembers));

    // eslint-disable-next-line no-await-in-loop
    let { team: existingTeam, members: existingMembers } = await getExistingTeamAndMembers(client, org, teamSlug, true);

    let parentId: number | undefined = undefined;

    if (existingTeam !== null && parent) {
      const { team } = await getExistingTeamAndMembers(client, org, teamSlug, false);
      if (team === null) {
        core.error(`Expected ${parent} to already be created`);
        throw new Error("Missing parent team");
      }
      parentId = team.id;

      // This is a bug  in the type schema
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      const rebuild = parentId !== (existingTeam as unknown as any)?.parent?.id;
      if (rebuild) {
        core.info(`removing team ${team.name} because parent team differs`);
        await client.teams.deleteInOrg({ org, team_slug: existingTeam.slug });

        existingTeam = null;
        existingMembers = [];
      }
    }

    if (existingTeam) {
      core.debug(`Existing team members for team slug ${teamSlug}:`);
      core.debug(JSON.stringify(existingMembers));

      await client.teams.updateInOrg({ org, team_slug: teamSlug, name: teamName, description });
      await removeFormerTeamMembers(client, org, teamSlug, existingMembers, desiredMembers);
    } else {
      core.debug(`No team was found in ${org} with slug ${teamSlug}. Creating one.`);
      await createTeamWithNoMembers(client, org, teamName, teamSlug, authenticatedUser, description, parentId);
    }

    await addNewTeamMembers(client, org, teamSlug, existingMembers, desiredMembers);
  }
}

function parseTeamData(rawTeamConfig: string, prefix: string): TeamData[] {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const teamsData: unknown = JSON.parse(JSON.stringify(yaml.safeLoad(rawTeamConfig)));
  const unexpectedFormatError = new Error(
    "Unexpected team data format (expected an object mapping team names to team metadata)",
  );

  if (typeof teamsData !== "object") {
    throw unexpectedFormatError;
  }

  const teams: TeamData[] = [];

  if (typeof teamsData !== "object" || teamsData === null) {
    core.error(`yaml data is wrong format`);
    throw new Error("yaml file format error");
  }

  Object.entries(teamsData).forEach(([teamName, teamData]: [string, unknown]) => {
    if (typeof teamName !== "string" || teamName === "") {
      core.error(`team name is not a string got: ${teamName}`);
      throw new Error("yaml file format error");
    }

    if (typeof teamData !== "object" || teamData === null) {
      core.error(`${teamName}: team data is not an object`);
      throw new Error("yaml file format error");
    }

    const parsedTeamData: TeamData = {
      team_name: prefixName(teamName, prefix),
      members: [],
      description: undefined,
      parent: undefined,
      team_sync_ignored: false,
    };

    if ("description" in teamData) {
      if (typeof teamData.description !== "string") {
        throw new Error(`Invalid description property for team ${teamName} (expected a string)`);
      }
      parsedTeamData.description = teamData.description;
    }

    if ("team_sync_ignored" in teamData) {
      if (typeof teamData.team_sync_ignored !== "boolean") {
        throw new Error(`Invalid team_sync_ignored property for team ${teamName} (expected a boolean)`);
      }
      parsedTeamData.team_sync_ignored = teamData.team_sync_ignored;
    }

    if ("parent" in teamData) {
      if (typeof teamData.parent !== "string") {
        throw new Error(`Invalid team_sync_ignored property for team ${teamName} (expected a boolean)`);
      }
      if (teamData.parent.trim() !== "") {
        parsedTeamData.parent = prefixName(teamData.parent, prefix);
      }
    }

    if ("members" in teamData) {
      if (!Array.isArray(teamData.members)) {
        core.error(`${teamName}: team members is not an array`);
        throw new Error("yaml file format error");
      }

      const usernames = teamData.members.map((member: unknown) => {
        if (typeof member === "object" && member !== null && "github" in member && typeof member.github === "string") {
          return member.github;
        }
        core.error(`${teamName}: invalid team member`);
        throw new Error(`Invalid member data encountered within team ${teamName}`);
      });

      parsedTeamData.members = usernames;
    }

    teams.push(parsedTeamData);
  });

  return teams;
}

function prefixName(unprefixedName: string, prefix: string): string {
  const trimmedPrefix = prefix.trim();
  const trimmed = unprefixedName.trim();

  return trimmedPrefix === "" ? trimmed : `${trimmedPrefix} ${trimmed}`;
}

async function removeFormerTeamMembers(
  client: github.GitHub,
  org: string,
  teamSlug: string,
  existingMembers: string[],
  desiredMembers: string[],
): Promise<void> {
  await Promise.all(
    existingMembers
      .filter((member) => !desiredMembers.includes(member))
      .map(async (username) => {
        core.debug(`Removing ${username} from ${teamSlug}`);
        await client.teams.removeMembershipInOrg({ org, team_slug: teamSlug, username });
      }),
  );
}

async function addNewTeamMembers(
  client: github.GitHub,
  org: string,
  teamSlug: string,
  existingMembers: string[],
  desiredMembers: string[],
): Promise<void> {
  await Promise.all(
    desiredMembers
      .filter((member) => !existingMembers.includes(member))
      .map(async (username) => {
        core.debug(`Adding ${username} to ${teamSlug}`);
        await client.teams.addOrUpdateMembershipInOrg({ org, team_slug: teamSlug, username });
      }),
  );
}

async function createTeamWithNoMembers(
  client: github.GitHub,
  org: string,
  teamName: string,
  teamSlug: string,
  authenticatedUser: string,
  description: string | undefined,
  parentId: number | undefined,
): Promise<void> {
  core.debug(`Creating team ${teamName} parent=${parentId}`)
  await client.teams.create({ org, name: teamName, description, privacy: "closed", parent_team_id: parentId });

  core.debug(`Removing creator (${authenticatedUser}) from ${teamSlug}`);

  await client.teams.removeMembershipInOrg({
    org,
    team_slug: teamSlug,
    username: authenticatedUser,
  });
}

async function getExistingTeamAndMembers(
  client: github.GitHub,
  org: string,
  teamSlug: string,
  getMembers: boolean,
): Promise<{
  team: Octokit.TeamsGetByNameResponse | null;
  members: string[];
}> {
  let existingTeam;
  let existingMembers: string[] = [];

  try {
    core.info(`Getting team info for ${teamSlug}`)
    const teamResponse = await client.teams.getByName({ org, team_slug: teamSlug });

    existingTeam = teamResponse.data;

    if (getMembers) {
      const membersResponse = await client.teams.listMembersInOrg({ org, team_slug: teamSlug });

      existingMembers = membersResponse.data.map((m) => m.login);
    }
  } catch (error) {
    existingTeam = null;
  }

  return { team: existingTeam, members: existingMembers };
}

async function fetchContent(client: github.GitHub, repoPath: string): Promise<string> {
  let response;

  try {
    response = await client.repos.getContents({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      path: repoPath,
      ref: github.context.sha,
    });
  } catch (err) {
    core.error(`Unable to load team file ${repoPath}`);
    throw err;
  }

  if (Array.isArray(response.data)) {
    throw new Error("path must point to a single file, not a directory");
  }

  const { content, encoding } = response.data;

  if (typeof content !== "string" || encoding !== "base64") {
    throw new Error("Octokit.repos.getContents returned an unexpected response");
  }

  return Buffer.from(content, encoding).toString();
}

// eslint-disable-next-line no-console
run().catch((err) => console.error(err));

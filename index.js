#!/usr/bin/env node

import { GoogleAuth } from "google-auth-library";
import { SingleBar } from "cli-progress";
import Configstore from "configstore";
import { writeFileSync } from "node:fs";

const configstore = new Configstore("firebase-tools");
const MAX_QOUTA_LIMIT_RETRY = 5;
const MAX_403_RETRY = 2; // Setting to a low value since more retries == hitting the quota limit faster
const QUOTA_LIMIT_PAUSE = 20_000;

let accessToken = null;
let accessTokenIssuedTime = 0;
let accessTokenLifetime = 3590; // Usually 3600, but lowering a bit
let refreshToken = null;

const completionBar = new SingleBar({
  format: "{bar} | {estimatedTime} | {completion} | {projectId} | {info}",
  barCompleteChar: "\u2588",
  barIncompleteChar: "\u2591",
  hideCursor: true,
});

function convertMsToHmsms(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const formattedHours = String(hours).padStart(2, "0");
  const formattedMinutes = String(minutes).padStart(2, "0");
  const formattedSeconds = String(seconds).padStart(2, "0");

  return `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
}

async function refreshAccessToken() {
  if (!refreshToken) {
    throw Error("Refresh token does not have valid value");
  }
  const googleAuth = new GoogleAuth({
    credentials: {
      refresh_token: refreshToken,
      client_id:
        "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      type: "authorized_user",
    },
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/firebase",
    ],
  });
  // Token duration is 3600 sec, lowering to 3500 to ensure no failure
  accessTokenIssuedTime = new Date().getTime();
  accessToken = await googleAuth.getAccessToken();
}

async function getProjects(token, pageSize = 1000) {
  let nextPageToken = null;
  const projectDataList = [];
  do {
    const pageTokenParam = nextPageToken ? `&pageToken=${nextPageToken}` : "";
    const res = await fetch(
      `https://content-firebase.googleapis.com/v1beta1/projects?pageSize=${pageSize}${pageTokenParam}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
        method: "GET",
      }
    );
    const json = await res.json();
    projectDataList.push(...json["results"]);
    nextPageToken = json["nextPageToken"];
  } while (nextPageToken);
  return projectDataList;
}

async function getProjectsWhereAnyRole({ email, projectIds, roles }) {
  const projectsDataMap = {};
  if (roles.length === 0) return projectsDataMap;
  let averageEta = 0;
  let retryQuotaLimitCounter = 0;
  let retry403Counter = 0;

  for (let i = 0; i < projectIds.length; i++) {
    const startTime = new Date();
    const projectId = projectIds[i];
    const apiUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`;

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (response.status === 200) {
        retryQuotaLimitCounter = 0;
        retry403Counter = 0;
        const policy = await response.json();
        if (policy && policy.bindings && policy.bindings.length > 0) {
          for (let binding of policy.bindings) {
            const role = binding.role;
            const userString = `user:${email}`;
            const normalizedMember = binding.members.map((member) =>
              member.toLowerCase()
            );
            if (roles.includes(role) && normalizedMember.includes(userString)) {
              if (!projectsDataMap[projectId]) {
                projectsDataMap[projectId] = [role];
              } else {
                projectsDataMap[projectId].push(role);
              }
            }
          }
        }
      } else {
        // If the request fails consecutive times, give up and proceed to next.
        if (
          retry403Counter >= MAX_403_RETRY ||
          retryQuotaLimitCounter >= MAX_QOUTA_LIMIT_RETRY
        )
          continue;

        if (response.status === 403) {
          i--;
          retry403Counter++;
          const isAccessTokenExpired =
            (new Date().getTime() - accessTokenIssuedTime) / 1000 >
            accessTokenLifetime;
          if (isAccessTokenExpired) {
            completionBar.update(i + 1, {
              info: `Retry ${retry403Counter} / ${MAX_403_RETRY}: got 403, refreshing access token...`,
            });
            await refreshAccessToken();
          } else {
            completionBar.update(i + 1, {
              info: `Retry ${retry403Counter} / ${MAX_403_RETRY}: got 403, trying again...`,
            });
          }
        } else if (response.status === 429) {
          i--;
          retryQuotaLimitCounter++;
          completionBar.update(i + 1, {
            info: `Retry ${retryQuotaLimitCounter} / ${MAX_QOUTA_LIMIT_RETRY}: hit quota limit, pausing for ${QUOTA_LIMIT_PAUSE}ms...`,
          });
          await new Promise((res) => setTimeout(res, QUOTA_LIMIT_PAUSE));
        } else {
          const res = await response.json();
          console.log(res);
          throw Error(`Unknown error encountered ${res?.error?.code || ""}`);
        }
        continue;
      }

      const endTime = new Date();
      const dt = endTime.getTime() - startTime.getTime();

      averageEta = (averageEta * i + dt) / (i + 1);
      const eta = averageEta * (projectIds.length - i - 1);
      const timer = convertMsToHmsms(eta);
      completionBar.update(i + 1, {
        projectId,
        completion: `${i + 1} / ${projectIds.length}`,
        estimatedTime: timer,
        info: "running...",
      });
    } catch (error) {
      console.log(error);
    }
  }

  return projectsDataMap;
}

function getGlobalDefaultAccount() {
  const user = configstore.get("user");
  const tokens = configstore.get("tokens");
  if (!user || !tokens) {
    return undefined;
  }
  return {
    user,
    tokens,
  };
}

function parseCommand() {
  const args = process.argv.slice(2);
  const roles = [];
  let outputFile = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output" || arg === "-o") {
      if (i + 1 < args.length) {
        outputFile = args[i + 1];
        i++;
      } else {
        throw Error("Missing value for `--output`");
      }
    } else {
      roles.push(arg);
    }
  }

  return {
    roles,
    outputFile,
  };
}

async function main() {
  const { roles, outputFile } = parseCommand();
  if (roles.length === 0) {
    throw Error("Invalid argument, missing roles.");
  }
  const account = getGlobalDefaultAccount();
  if (!account) {
    throw Error(
      "This script uses firebase-tools authentication. Please run `firebase login`"
    );
  }
  const email = account.user.email.toLowerCase();
  console.log(`Searching for user:${email}`);
  console.log(`With roles: ${roles.join(", ")}`);

  refreshToken = account.tokens.refresh_token;
  await refreshAccessToken();

  const projects = await getProjects(accessToken);
  const projectIds = projects.map((data) => data.projectId);
  console.log(`Found ${projectIds.length} projects`);

  completionBar.start(projectIds.length, 0, {
    projectId: "loading...",
    completion: `0 / ${projectIds.length}`,
    estimatedTime: "loading...",
    info: "",
  });

  const projectRoleMap = await getProjectsWhereAnyRole({
    email: email,
    projectIds: projectIds,
    roles,
  });

  completionBar.stop();

  const output = JSON.stringify(projectRoleMap, null, 2);
  console.log(`${Object.keys(projectRoleMap).length} projects`);
  if (outputFile) {
    writeFileSync(outputFile, output, {
      encoding: "utf-8",
    });
    console.log(`Output written to ${outputFile}`);
  } else {
    console.log(output);
  }
}

main();

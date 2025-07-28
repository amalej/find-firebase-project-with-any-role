#!/usr/bin/env node

import { GoogleAuth } from "google-auth-library";
import { SingleBar } from "cli-progress";
import Configstore from 'configstore';
import { writeFileSync } from "node:fs"

const configstore = new Configstore('firebase-tools');

const completionBar = new SingleBar({
    format: '{bar} |' + ' {estimatedTime} |' + ' {completion} |' + ' {projectId} ',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
});

function convertMsToHmsms(milliseconds) {
    const totalSeconds = Math.ceil(milliseconds / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);

    const formattedHours = String(hours).padStart(2, '0');
    const formattedMinutes = String(minutes).padStart(2, '0');
    const formattedSeconds = String(seconds).padStart(2, '0');

    return `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
}

async function getProjects(token, pageSize = 1000) {
    let nextPageToken = null
    const projectDataList = []
    do {
        const pageTokenParam = nextPageToken ? `&pageToken=${nextPageToken}` : ""
        const res = await fetch(`https://content-firebase.googleapis.com/v1beta1/projects?pageSize=${pageSize}${pageTokenParam}`, {
            "headers": {
                "authorization": `Bearer ${token}`,
            },
            "method": "GET"
        });
        const json = await res.json()
        projectDataList.push(...json["results"])
        nextPageToken = json["nextPageToken"]
    } while (nextPageToken)
    return projectDataList
}

async function getProjectsWhereAnyRole({ accessToken, email, projectIds, roles }) {
    const projectsDataMap = {}
    if (roles.length === 0) return projectsDataMap
    let averageEta = 0
    for (let i = 0; i < projectIds.length; i++) {
        const startTime = new Date()
        const projectId = projectIds[i]
        const apiUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`;

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        });

        const policy = await response.json();
        if (policy && policy.bindings && policy.bindings.length > 0) {
            for (let binding of policy.bindings) {
                const role = binding.role
                const userString = `user:${email}`
                const normalizedMember = binding.members.map((member) => member.toLowerCase())
                if (roles.includes(role) && normalizedMember.includes(userString)) {
                    if (!projectsDataMap[projectId]) {
                        projectsDataMap[projectId] = [role]
                    } else {
                        projectsDataMap[projectId].push(role)
                    }
                }
            }
        }

        const endTime = new Date()
        const dt = endTime.getTime() - startTime.getTime()

        averageEta = (averageEta * i + dt) / (i + 1)
        const eta = averageEta * (projectIds.length - i - 1)
        const timer = convertMsToHmsms(eta)
        completionBar.update(i + 1, { projectId, completion: `${i + 1} / ${projectIds.length}`, estimatedTime: timer })
    }

    return projectsDataMap
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
        if (arg === '--output' || arg === '-o') {
            if (i + 1 < args.length) {
                outputFile = args[i + 1];
                i++
            } else {
                throw Error('Missing value for `--output`')
            }
        } else {
            roles.push(arg);
        }
    }

    return {
        roles, outputFile
    }
}

async function main() {
    const { roles, outputFile } = parseCommand()
    if (roles.length === 0) {
        throw Error("Invalid argument, missing roles.")
    }
    const account = getGlobalDefaultAccount()
    if (!account) {
        throw Error("This script uses firebase-tools authentication. Please run `firebase login`")
    }
    const email = account.user.email.toLowerCase()
    console.log(`Searching for user:${email}`)
    console.log(`With roles: ${roles.join(", ")}`)

    const refreshToken = account.tokens.refresh_token
    const googleAuth = new GoogleAuth({
        credentials: {
            refresh_token: refreshToken,
            client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
            client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
            type: "authorized_user"
        },
        scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase"],
    });
    const accessToken = await googleAuth.getAccessToken();
    const projects = await getProjects(accessToken)

    const projectIds = projects.map((data) => data.projectId)
    console.log(`Found ${projectIds.length} projects`)

    completionBar.start(projectIds.length, 0, {
        projectId: 'null',
        completion: `0 / ${projectIds.length}`,
        estimatedTime: "calculating..."
    });

    const projectRoleMap = await getProjectsWhereAnyRole({
        accessToken,
        email: email,
        projectIds: projectIds,
        roles,
    })

    completionBar.stop()

    const output = JSON.stringify(projectRoleMap, null, 2)
    console.log(`${Object.keys(projectRoleMap).length} projects`)
    if (outputFile) {
        writeFileSync(outputFile, output, {
            encoding: "utf-8"
        })
        console.log(`Output written to ${outputFile}`)
    } else {
        console.log(output)
    }
}

main()
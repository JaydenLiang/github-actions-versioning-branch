import * as core from '@actions/core';
import * as github from '@actions/github';
import axios, { AxiosRequestConfig } from 'axios';
import StatusCodes from 'http-status-codes';
import semver from 'semver';

async function fetchPackageJson(owner: string, repo: string, branch: string): Promise<{ [key: string]: unknown }> {
    const basePackageJsonUrl = `https://raw.githubusercontent.com/` +
        `${owner}/${repo}/${branch}/package.json`;

    const options: AxiosRequestConfig = {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        },
        url: basePackageJsonUrl,
        timeout: 30000
    };
    const response = await axios(options);
    return response.data;
}

function initOctokit() {
    // usage example from: https://github.com/actions/toolkit/tree/main/packages/github
    // This should be a token with access to your repository scoped in as a secret.
    // The YML workflow will need to set myToken with the GitHub Secret Token
    // myToken: ${{ secrets.GITHUB_TOKEN }}
    // https://help.github.com/en/actions/automating-your-workflow-with-github-actions/authenticating-with-the-github_token#about-the-github_token-secret
    const token = core.getInput('github-token');
    const octokit = github.getOctokit(token);
    return octokit;
}

async function main(): Promise<void> {
    try {
        const octokit = initOctokit();
        const [owner, repo] = github.context.payload.repository.full_name.split('/');
        const baseBranch = core.getInput('base-branch') || '';
        const versionLevel = core.getInput('version-level') || '';
        const branchPrefix = core.getInput('name-prefix') || '';
        const preId = core.getInput('pre-id') || '';
        const customVersion = core.getInput('custom-version') || '';

        console.log('base-branch:', baseBranch);
        console.log('version-level:', versionLevel);
        console.log('name-prefix:', branchPrefix);
        console.log('pre-id:', preId);
        console.log('custom-version:', customVersion);
        // input validation
        if (!baseBranch) {
            throw new Error('Must provide base branch.');
        }
        if (!['major', 'minor', 'patch', 'prerelease'].includes(versionLevel)) {
            throw new Error(`Invalid version-level: ${versionLevel}`);
        }

        // validate against semver
        if (customVersion && !semver.valid(customVersion)) {
            throw new Error(`Custom version: ${customVersion}, is invalid.`);
        }
        const basePackageJson: { [key: string]: unknown } = await fetchPackageJson(owner, repo, baseBranch);
        const baseVersion = basePackageJson.version as string;

        if (!semver.valid(baseVersion)) {
            throw new Error(`Base version: ${baseVersion}, is invalid.`);
        }

        const isPrerelease = versionLevel === 'prerelease' || !!preId;
        let releaseType: semver.ReleaseType;

        switch (versionLevel) {
            case 'prerelease':
                releaseType = 'prerelease';
                break;
            case 'major':
                releaseType = preId ? 'premajor' : 'major';
                break;
            case 'minor':
                releaseType = preId ? 'preminor' : 'minor';
                break;
            case 'patch':
            default:
                releaseType = preId ? 'prepatch' : 'patch';
                break;
        }

        console.log('release type: ', releaseType);

        const newVersion =
            customVersion || semver.inc(baseVersion, releaseType, false, preId || null);

        console.log('new version: ', newVersion);

        // create a branch reference
        const headBranch = `${branchPrefix}${newVersion}`;
        const headBranchRef = `refs/heads/${headBranch}`;
        console.log('Creating a reference: ', headBranchRef);
        // get the head commit of the base branch in order to create a new branch on it
        const getCommitResponse = await octokit.repos.getCommit({
            owner: owner,
            repo: repo,
            ref: `refs/heads/${baseBranch}`
        });
        console.log('get commit result: ', JSON.stringify(getCommitResponse, null, 4));
        // check if branch already exists
        const getRefResponse = await octokit.git.getRef({
            owner: owner,
            repo: repo,
            ref: headBranchRef
        });

        if (getRefResponse.status === StatusCodes.OK) {
            console.log(`branch: ${headBranch}, already exists.`);
        } else if (getRefResponse.status === StatusCodes.NOT_FOUND) {
            // create a branch ref on this commit
            const createRefResponse = await octokit.git.createRef({
                owner: owner,
                repo: repo,
                ref: headBranchRef,
                sha: getCommitResponse.data.sha
            });
            console.log(`branch: ${headBranch}, created.`);
            console.log('create ref result: ', JSON.stringify(createRefResponse, null, 4));
        } else {
            throw new Error(`Unhandled status: ${getRefResponse.status},` +
                ` in attempting to get ref for branch: ${headBranch}.`);
        }

        core.setOutput('base-branch', baseBranch);
        core.setOutput('base-version', baseVersion);
        core.setOutput('head-branch', headBranch);
        core.setOutput('head-version', newVersion);
        core.setOutput('is-prerelease', isPrerelease && 'true' || 'false');
        // Get the JSON webhook payload for the event that triggered the workflow
        const payload = JSON.stringify(github.context.payload, null, 4);
        console.log('payload:', payload);
    } catch (error) {
        core.setFailed((error as Error).message);
    }
}

main();

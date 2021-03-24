import * as core from '@actions/core';
import * as github from '@actions/github';
import axios, { AxiosRequestConfig } from 'axios';
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
        const versionType = core.getInput('version-type') || '';
        const branchPrefix = core.getInput('version-branch-prefix') || '';
        const prerelease = core.getInput('prerelease') === 'true';

        const preId = core.getInput('pre-id') || '';
        // input validation
        if (!baseBranch) {
            throw new Error('Must provide base branch.');
        }
        if (!['major', 'minor', 'patch', 'prerelease'].includes(versionType)) {
            throw new Error(`Invalid version-type: ${versionType}`);
        }

        // validate against semver
        const basePackageJson: { [key: string]: unknown } = await fetchPackageJson(owner, repo, baseBranch);
        const baseVersion = basePackageJson.version as string;

        if (!semver.valid(baseVersion)) {
            throw new Error(`Base version ${baseVersion} is invalid.`);
        }

        let releaseType: semver.ReleaseType;

        switch (versionType) {
            case 'major':
                releaseType = prerelease ? 'premajor' : 'major';
                break;
            case 'minor':
                releaseType = prerelease ? 'preminor' : 'minor';
                break;
            case 'major':
                releaseType = prerelease ? 'prepatch' : 'patch';
                break;
            default:
                releaseType = 'prerelease';
                break;
        }

        const newVersion = semver.inc(baseVersion, releaseType, false, preId || null);

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
        // create a branch ref on this commit
        const createRefResponse = await octokit.git.createRef({
            owner: owner,
            repo: repo,
            ref: headBranchRef,
            sha: getCommitResponse.data.sha
        });
        console.log('create ref result: ', JSON.stringify(createRefResponse, null, 4));

        core.setOutput('base-branch', baseBranch);
        core.setOutput('base-version', baseVersion);
        core.setOutput('head-branch', headBranch);
        core.setOutput('head-version', newVersion);
        // Get the JSON webhook payload for the event that triggered the workflow
        const payload = JSON.stringify(github.context.payload, null, 4);
        console.log('payload:', payload);
    } catch (error) {
        core.setFailed((error as Error).message);
    }
}

main();

import * as core from '@actions/core';
import * as github from '@actions/github';
import axios, { AxiosRequestConfig } from 'axios';
import StatusCodes from 'http-status-codes';
import semver from 'semver';

// the interface for the error octokit will throw. @actions/github doesn' export it for use.
interface RequestError {
    status: number;
    message?: string;
    [key: string]: unknown;
}

interface PackageJson {
    name: string;
    version: string;
    [key: string]: string;
}

async function fetchPackageJson(owner: string, repo: string, branch: string): Promise<PackageJson> {
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

async function createVersioningBranch(): Promise<void> {
    const octokit = initOctokit();
    const [owner, repo] = github.context.payload.repository.full_name.split('/');
    const baseBranch = core.getInput('base-branch') || '';
    const versionLevel = core.getInput('version-level') || '';
    const branchPrefix = core.getInput('name-prefix') || '';
    let preId = core.getInput('pre-id') || '';
    const customVersion = core.getInput('custom-version') || '';

    console.log('inputs:');
    console.log('----------');
    console.log('base-branch:', baseBranch);
    console.log('version-level:', versionLevel);
    console.log('name-prefix:', branchPrefix);
    console.log('pre-id:', preId);
    console.log('custom-version:', customVersion);
    console.log('----------');
    // input validation
    if (!baseBranch) {
        throw new Error('Must provide base branch.');
    }
    if (!customVersion && !['major', 'minor', 'patch', 'prerelease'].includes(versionLevel)) {
        throw new Error(`Invalid version-level: ${versionLevel}`);
    }

    // validate custom version against semver
    if (customVersion && !semver.valid(customVersion)) {
        throw new Error(`Custom version: ${customVersion}, is invalid.`);
    }

    let releaseType: semver.ReleaseType;

    let headVersion: semver.SemVer;

    // validate base branch (existing or not)
    try {
        await octokit.git.getRef({
            owner: owner,
            repo: repo,
            ref: `heads/${baseBranch}` // NOTE: must omit 'refs/'
        });
    } catch (error) {
        if ((error as RequestError).status === StatusCodes.NOT_FOUND) {
            throw new Error(`Base: ${baseBranch}, not found.`);
        } else {
            console.log(`Unknown error occurred when attempting to get ref: heads/${baseBranch}`);
            throw error;
        }
    }

    const basePackageJson: PackageJson = await fetchPackageJson(owner, repo, baseBranch);
    const baseVersion = basePackageJson.version as string;

    if (!semver.valid(baseVersion)) {
        throw new Error(`Base version: ${baseVersion}, is invalid.`);
    }

    if (customVersion) {
        console.log('release type: custom');
        headVersion = semver.parse(customVersion);
    } else {
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
        headVersion = semver.parse(semver.inc(baseVersion, releaseType, false, preId || null));
    }

    console.log('head version: ', headVersion.version);

    let prereleaseComponents = Array.from(semver.prerelease(headVersion)) || [];

    const isPrerelease = prereleaseComponents.length > 0;

    console.log('is prerelease: ', isPrerelease);

    let preInc: string = ''; // the incremental part of the prerelease component.
    if (isPrerelease) {
        // preid could be a string, a pure number, or a combination of both.
        console.log('prerelease components: ', ...prereleaseComponents);
        preInc = prereleaseComponents.pop();
        preId = prereleaseComponents.join('.');
    }

    console.log('pre-id: ', preId);
    console.log('pre-inc: ', preInc);

    // create a branch reference
    const headBranch = `${branchPrefix}${headVersion}`;
    console.log('Creating a reference: ', `heads/${headBranch}`);
    // get the head commit of the base branch in order to create a new branch on it
    const getCommitResponse = await octokit.repos.getCommit({
        owner: owner,
        repo: repo,
        ref: `refs/heads/${baseBranch}` // NOTE: must include 'refs/'
    });
    console.log('get commit result: ', JSON.stringify(getCommitResponse, null, 4));
    // check if branch already exists
    let headRefExists: boolean;
    try {
        await octokit.git.getRef({
            owner: owner,
            repo: repo,
            ref: `heads/${headBranch}` // NOTE: must omit 'refs/'
        });
        headRefExists = true;
    } catch (error) {
        if ((error as RequestError).status === StatusCodes.NOT_FOUND) {
            headRefExists = false;
        } else {
            console.log(`Unknown error occurred when attempting to get ref: heads/${headBranch}`);
            throw error;
        }
    }

    if (headRefExists) {
        console.log(`branch: ${headBranch}, already exists.`);
    } else {
        // create a branch ref on this commit
        const createRefResponse = await octokit.git.createRef({
            owner: owner,
            repo: repo,
            ref: `refs/heads/${headBranch}`, // NOTE: must include 'refs/'
            sha: getCommitResponse.data.sha
        });
        console.log(`branch: ${headBranch}, created.`);
        console.log('create ref result: ', JSON.stringify(createRefResponse, null, 4));
    }

    core.setOutput('base-branch', baseBranch);
    core.setOutput('base-version', baseVersion);
    core.setOutput('head-branch', headBranch);
    core.setOutput('head-version', headVersion.version);
    core.setOutput('is-new-branch', headRefExists && 'false' || 'true');
    core.setOutput('is-prerelease', isPrerelease && 'true' || 'false');
    core.setOutput('major', headVersion.major);
    core.setOutput('minor', headVersion.minor);
    core.setOutput('patch', headVersion.patch);
    core.setOutput('pre-id', preId);
    core.setOutput('pre-inc', preInc);
}

async function extractInfoFromPullRequest(prNumber: number): Promise<void> {
    const octokit = initOctokit();
    const [owner, repo] = github.context.payload.repository.full_name.split('/');

    // NOTE: if pullrequest not found or other errors, stop processing.
    const pullrequest = await octokit.pulls.get({
        owner: owner,
        repo: repo,
        pull_number: prNumber,
    });

    const baseBranch = pullrequest.data.base.ref;
    const headBranch = pullrequest.data.head.ref;

    const basePackageJson: PackageJson = await fetchPackageJson(owner, repo, baseBranch);
    const baseVersion = basePackageJson.version as string;

    const headPackageJson: PackageJson = await fetchPackageJson(owner, repo, headBranch);
    const headVersion = headPackageJson.version as string;

    const headSemver = semver.parse(headVersion);
    const isPrerelease = headSemver.prerelease.length > 0;

    core.setOutput('base-branch', baseBranch);
    core.setOutput('base-version', baseVersion);
    core.setOutput('head-branch', headBranch);
    core.setOutput('head-version', headVersion);
    core.setOutput('is-prerelease', isPrerelease && 'true' || 'false');
}

async function main(): Promise<void> {
    try {
        // Get the JSON webhook payload for the event that triggered the workflow
        const payload = JSON.stringify(github.context.payload, null, 4);
        console.log('payload:', payload);
        const prNumber: number = core.getInput('pr-number') && Number(core.getInput('pr-number')) || NaN;
        if (isNaN(prNumber)) {
            console.log('pull request number not provided.');
            await createVersioningBranch();
        } else {
            console.log(`pull request number: ${prNumber}, found.`);
            await extractInfoFromPullRequest(prNumber);
        }
    } catch (error) {
        console.warn(error);
        core.setFailed((error as RequestError).message);
    }
}

main();

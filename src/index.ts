import * as core from '@actions/core';
import * as github from '@actions/github';
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

async function main(): Promise<void> {
    try {
        const [owner, repo] = github.context.payload.repository.full_name.split('/');
        const baseBranch = core.getInput('base-branch') || '';
        const versionType = core.getInput('version-type') || '';
        const prerelease = core.getInput('prerelease') === 'true';
        const preId = core.getInput('pre-id') || '';
        // input validation
        if (!baseBranch) {
            throw new Error('Must provide base branch.');
        }
        if (!['major', 'minor', 'patch'].includes(versionType)) {
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
                break;
        }

        const newVersion = semver.inc(baseVersion,)


        core.setOutput('base-branch', baseBranch);
        core.setOutput('base-version', baseVersion);
        core.setOutput('head-branch', baseBranch);
        core.setOutput('head-version', baseVersion);
        core.setOutput('is-prerelease', isPrerelease);
        core.setOutput('is-draft-pr', prCreateDraft);

        // get the pr with the same head and base
        const prListResponse = await octokit.pulls.list({
            owner: owner,
            repo: repo,
            head: headBranch,
            base: baseBranch,
            sort: 'updated', // will sort all pr by updated time
            direction: 'desc', // will sort with latest ones on top
        });

        // ASSERT: the 1st pr is the latest updated one (either open or closed)
        let pullRequest = prListResponse.data.length && prListResponse.data[0];

        // additional checking if need to check fail-if-exist
        console.log('Action [pr-fail-if-exist] is set: ' +
            `${prFailIfExist === 'true' && 'true' || 'false'}`);
        if (prFailIfExist === 'true' && pullRequest && pullRequest.state === 'open') {
            throw new Error(
                `Not allowed to re-issue a pull request to base branch: ${baseBranch}` +
                ` from head branch: ${headBranch}. An open pull request is found.`);
        }
        // if an open pr is found, update it. otherwise, create one
        if (pullRequest) {
            const prUpdateResponse = await octokit.pulls.update({
                owner: owner,
                repo: repo,
                pull_number: pullRequest.number,
                title: prTitle || undefined,
                body: prDescription || undefined,
                state: 'open', // reopen if prviously closed.
            });
            pullRequest = prUpdateResponse.data;
        }
        // create a pr with the above title and description.
        else {
            const prCreateResponse = await octokit.pulls.create({
                owner: owner,
                repo: repo,
                head: headBranch,
                base: baseBranch,
                title: prTitle || undefined,
                body: prDescription || undefined,
                draft: prCreateDraft === 'true'
            });
            pullRequest = prCreateResponse.data;
        }
        core.setOutput('pull-request-number', pullRequest.number);
        core.setOutput('pull-request-url', pullRequest.url);

        // add or update a review comment to store useful transitional informations.
        const infoCommentTemplate = await loadTemplate<infoCommentTemplate>(owner, repo, headBranch, 'templates/pr-info-comment.yml');
        const infoCommentBody = replace(infoCommentTemplate.body);
        // get comments and filter by github bot author:
        // login: github-actions[bot]
        // id: 41898282
        const prListCommentResponse = await octokit.issues.listComments({
            owner: owner,
            repo: repo,
            issue_number: pullRequest.number
        });
        const [infoComment] = prListCommentResponse.data.filter(comment => {
            return comment.user.login === 'github-actions[bot]' || comment.user.id === 41898282;
        });

        // info comment is found, update it.
        if (infoComment) {
            await octokit.issues.updateComment({
                owner: owner,
                repo: repo,
                comment_id: infoComment.id,
                body: infoCommentBody
            });
        }
        // otherwise, add a comment
        else {
            await octokit.issues.createComment({
                owner: owner,
                repo: repo,
                issue_number: pullRequest.number,
                body: infoCommentBody
            });
        }
        // add assignee if needed
        const assignees: string[] = [];
        if (prAssignees.length) {
            // check if a user can be assigned, filter non-assignable users
            // see: https://octokit.github.io/rest.js/v18#issues-check-user-can-be-assigned
            await Promise.allSettled(
                prAssignees.map(async (assignee) => {
                    let neg = 'not ';
                    console.log(`Checking before adding assignee: ${assignee}...`);
                    const res = await octokit.issues.checkUserCanBeAssigned({
                        owner: owner,
                        repo: repo,
                        assignee: assignee
                    });
                    if (res.status === StatusCodes.NO_CONTENT) {
                        assignees.push(assignee);
                        neg = '';
                    }
                    console.log(`assignee: ${assignee} is ${neg}assignable.`);
                }
                ));
            if (assignees.length) {
                await octokit.issues.addAssignees({
                    owner: owner,
                    repo: repo,
                    issue_number: pullRequest.number,
                    assignees: prAssignees
                });
            }
        }
        // output the actual assignees.
        core.setOutput('assignees', assignees.length && assignees.join(',') || '');

        // add reviewers if needed
        if (prReviewers.length || prTeamReviewers.length) {
            await octokit.pulls.requestReviewers({
                owner: owner,
                repo: repo,
                pull_number: pullRequest.number,
                reviewers: prReviewers,
                team_reviewers: prTeamReviewers
            });
        }
        // output the actual reviewers and / or team reviewers.
        core.setOutput('reviewers', prReviewers.length && prReviewers.join(',') || '');
        core.setOutput('team-reviewers', prTeamReviewers.length && prTeamReviewers.join(',') || '');

        // add labels if needed
        if (prLabels.length) {
            await octokit.issues.addLabels({
                owner: owner,
                repo: repo,
                issue_number: pullRequest.number,
                labels: prLabels
            });
        }
        // output the actual lables.
        core.setOutput('labels', prLabels.length && prLabels.join(',') || '');

        // Get the JSON webhook payload for the event that triggered the workflow
        const payload = JSON.stringify(github.context.payload, null, 4);
        console.log('payload:', payload);
    } catch (error) {
        core.setFailed((error as Error).message);
    }
}

main();

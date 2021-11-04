#!/usr/bin/env node

const execa = require('execa')
const glob = require('glob')
const inquirer = require('inquirer')
const mustache = require('mustache')
const path = require('path')
const yargs = require('yargs/yargs')
const { argv } = yargs(process.argv.slice(2))

async function main () {
  // is `gh` installed?
  try {
    await execa.command('which gh')
  } catch (error) {
    console.error('Please install GitHub CLI: brew install gh')
    process.exit(0)
  }

  // logged in to `gh`? 
  try {
    await execa.command('gh auth status -h github.com')
  } catch (error) {
    console.error('Please log in to GitHub CLI: gh auth login')
    process.exit(0)
  }

  // check for uncommitted changes
  try {
    const { stdout } = await execa.command('git status -s')
    const numLines = stdout.split('\n').length
    if (numLines > 0) {
      console.error(`You have ${numLines} uncommitted changes. Please commit your changes first.`)
      process.exit(0)
    }
  } catch (error) {
    console.error('Uncommitted changes check failed', error)
    process.exit(0)
  }

  // get branch name
  let branch
  try {
    const { stdout } = await execa.command('git rev-parse --abbrev-ref HEAD')
    branch = stdout
  } catch (error) {
    console.error('Branch not found. Are you inside a git project?', error)
    process.exit(0)
  }

  // parse issue number from branch name
  let number
  const matches = branch.match(/[\d]+/)
  if (matches?.length > 0) {
    number = matches[0]
  } else {
    console.error('It doesn\'t look like you follow a branch naming convention. Try using a number in your branch name.')
    process.exit(0)
  }

  // pull issue 
  let title, description
  try {
    const { stdout } = await execa.command(`gh issue view ${number} --json title,body`)
    const json = JSON.parse(stdout)
    title = json.title
    description = json.body
  } catch (error) {
    console.error('Could not pull issue', error)
    process.exit(0)
  }

  // read pull request template from disk
  let template = '{{netlify.issueDescription}}\n\n{{netlify.deployPreview}}'
  try {
    const { stdout } = await execa.command(`cat ./.github/pull_request_template.md`)
    template = stdout
  } catch (error) {
    console.warn('No pull request template found, starting from scratch...')
  }

  // prompt for entry path
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'entryPath',
      message: 'At what path would you like your reviewers to land in your Deploy Preview?',
      default: '/',
    },
  ])
  const entryPath = answers.entryPath || '/'

  // run custom scripts found in /.github/drafts/*.js
  const customPromises = glob.sync('./.github/draft/*.js').map((file) => {
    const arg = file.split('/')[file.split('/').length - 1].replace(/\.js$/, '')
    const func = require(path.resolve(file))
    return new Promise(resolve => resolve(func(argv[arg])))
  })
  const customItems = await Promise.all(customPromises)
  const customValues = customItems.reduce((obj, item) => ({...obj, ...item}), {})

  // find next Deploy Preview number (naive/hacky approach)
  let nextNumber
  try {
    const promises = [
      execa.command('gh issue list --search sort:created-desc --state all --limit 1'),
      execa.command('gh pr list --search sort:created-desc --state all --limit 1'),
    ]
    const [issueResponse, prResponse] = await Promise.all(promises)
    const [largestIssueNumber] = issueResponse.stdout.split(/[\s]+/)
    const [largestPullNumber] = prResponse.stdout.split(/[\s]+/)
    nextNumber = Math.max(Number(largestIssueNumber), Number(largestPullNumber)) + 1
  } catch (error) {
    console.error('Error fetching most recent issues and pulls.', error)
    process.exit(0)
  }

  mustache.escape = text => text
  const body = mustache.render(template, {
    netlify: {
      issueDescription: `<details><summary>Linked issue description (expand for more context)</summary>${description}</details>`,
      deployPreview: `https://deploy-preview-${nextNumber}--${argv.site}.netlify.app${entryPath}`,
      setEntryPath: `@netlify ${entryPath}`,
      ...customValues,
    }
  });

  // create draft pr
  try {
    const { stderr, stdout } = await execa('gh', 
      ['pr', 'create', '--draft', '--head', branch, '--assignee', '@me', '--title', `${number}: ${title}`, '--body', body]
    )

    if (stderr) {
      console.error(stderr)
    } else {
      console.log(stdout)
    }
  } catch (error) {
    console.error('Could not create draft PR', error)
    process.exit(0)
  }
}

main()

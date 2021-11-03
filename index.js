#!/usr/bin/env node

import execa from 'execa'
import glob from 'glob'
import inquirer from 'inquirer'
import mustache from 'mustache'
import path from 'path'
import yargs from 'yargs'
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

  // get remote name 
  let remote
  try {
    const { stdout } = await execa.command('git remote -v')
    remote = stdout
  } catch (error) {
    console.error('Remote not found. Are you inside a git project?')
    console.error(error)
    process.exit(0)
  }

  // get branch name
  let branch
  try {
    const { stdout } = await execa.command('git rev-parse --abbrev-ref HEAD')
    branch = stdout
  } catch (error) {
    console.error('Branch not found. Are you inside a git project?')
    console.error(error)
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
  console.log(entryPath)

  // run custom scripts found in /.github/drafts/*.js
  const customPromises = glob.sync('./.github/draft/*.js').map(async (file) => {
    console.log(file)
    const arg = file.split('/')[file.split('/').length - 1].replace(/\.js$/, '')
    console.log(arg)
    const func = await import(path.resolve(file))
    console.log(func)
    return new Promise(resolve => resolve(func(argv[arg])))
  })
  console.log(customPromises)
  const customItems = await Promise.all(customPromises)
  console.log(customItems)
  const customValues = customItems.reduce((obj, item) => ({...obj, ...item}), {})
  console.log(customValues)

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
    const { stdout } = await execa.command(`gh pr create --draft --assignee @me --title="${number}: ${title}" --body="${body}"`)
    console.log(stdout)
  } catch (error) {
    console.error('Could not create draft PR', error)
    process.exit(0)
  }
}

main()

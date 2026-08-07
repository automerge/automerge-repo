# Contributing

## Development workflow

Prerequisites:

- pnpm

To install dependencies and build the packages run:

```sh
pnpm install
pnpm build
```

Note: You need to build the packages before running the demo apps.

### Running the demo apps

```sh
pnpm dev
```

### Running tests

```sh
pnpm test
```

## Releasing

There are two things you might want to know here. Firstly "how do I release a new version?" and secondly "what actually happens when we release a new version?". We'll start with the second question, but you can jump straight to the [how to release](#how-to-release) section if you're here for the first.

### What is a release

This package is a monorepo. Every directory in `./packages` is a separate package which is released on `npm`. At the moment we version all of these packages together. The version in the top level `package.json` is the version that is used for all of the packages.

We use GitHub Actions to actually automate the release process. There is a github action which publishes the whole monorepo to `npm` any time a new tag of the form `v*` is pushed to the repository and the tag matches the version in the top level `package.json`. (This action also checks that the tag matches the version in the `package.json` in each package directory.)

If we were just to have this action then releasing a new package would involve manually updating all the versions in all the `package.json` files, then merging a PR, then pushing a tag. This is all very onerous and automatable though. To make it easier we do a few things:

- Use the `./scripts/version.mjs` script to update the version in all the `package.json` files to match that in the top level `package.json`
- Any time the `package.json` version on `main` changes there is a github action which (again using the `./scripts/version.mjs` script) checks if there is a new version and if so creates a new tag

The final step is a slight lie. Tags created by GitHub Actions don't trigger further actions. This means that the publish action doesn't run when tags are created by the merge PR action. Thus in the merge PR action we programmatically trigger the publish action as well as creating the new tag.

### How to release

To release a new version:

1. Update the version in the top level `package.json` to the desired version
2. Run `npm run version:bump` to update the version in all the `package.json` files in the `./packages` directory
3. Push the changes to a new PR
4. Merge the PR

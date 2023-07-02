# Automerge Repo Sync Server

A very simple automerge-repo synchronization server. It pairs with the websocket client protocol
found in `@automerge/automerge-repo-network-websocket`.

The server is an unsecured [Express](https://expressjs.com/) app. It is really just for
demonstration purposes at this point; you probably don't want to use it for anything real yet. This
isn't a great way to operate (or the only way) but it's a useful demonstration of what a
client/server deployment might look like.

## Setting up

Before getting started, make sure you've run `yarn`, and `yarn build` at the root of the monorepo. This will install all your dependencies and make sure the other libraries are compiled.

## Run the sync server

`yarn start:syncserver`

## Set up a sync-server on ubuntu

Set up basic firewall:

```
$ sudo ufw allow OpenSSH
$ sudo ufw allow http
$ sudo ufw allow https
$ sudo ufw enable
```

Install git:

```
$ sudo apt-get install git
```

Install node:

```
$ curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - &&\
sudo apt-get install -y nodejs
```

Clone repo (may require setting up ssh keys to clone from github)

```
$ git clone git@github.com:pvh/automerge-repo.git
```

Build everything:

```
$ cd automerge-repo
$ yarn build
```

Run a server:

```
$ cd packages/automerge-repo-sync-server
$ PORT=<your preferred port> yarn start
```

## Contributors

Originally written by @pvh.

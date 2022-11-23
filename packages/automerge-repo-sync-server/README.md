# Automerge-Repo Sync Server

A very simple automerge-repo synchronization server. It pairs with the websocket client protocol found in `automerge-repo-network-websocket`.

It wraps those things in an unsecured `express` app. This isn't a great way to operate (or the only way) but it's a useful demonstration of what a client/server deployment might look like.

## Running sync-server

`yarn start`

Good luck. You're gonna need it.

## Set up a sync-server on ubuntu

Set up basic firewall:

$ sudo ufw allow OpenSSH
$ sudo ufw allow http
$ sudo ufw allow https
$ sudo ufw enable

Install git:

$ sudo apt-get install git

Install node:

$ curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - &&\
sudo apt-get install -y nodejs

Clone repo (may require setting up ssh keys to clone from github)

$ git clone git@github.com:pvh/automerge-repo.git

Build everything:

$ cd automerge-repo
$ yarn build

Run a server:

$ cd packages/automerge-repo-sync-server
$ PORT=<your preferred port> yarn start

## Contributors

Originally written by @pvh.
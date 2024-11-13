# How to hack

## Dependencies

Symlink `beelay-core` and `automerge` from `./vendor`

```bash
cd vendor
ln -s $BEEHIVE_PROJECT_DIR beehive
ln -s $AUTOMERGE_PROJECT_DIR automerge
```

Then any time you change the `automerge-wasm`, or `beehive`, or javascript bindings build the JS bindings

```bash
cd vendor/automerge/javascript 
yarn run build
```

# Find Firebase Project With Role

## How to use

Search for projects where you are an `owner`

```
npx find-firebase-project-with-any-role roles/owner
```

Search for projects where you are an `owner` or an `editor`

```
npx find-firebase-project-with-any-role roles/owner roles/editor
```

Specify an an output with `--output` flag

```
npx find-firebase-project-with-any-role roles/owner roles/editor --output ./test.json
```

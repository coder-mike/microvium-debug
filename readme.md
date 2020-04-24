# Microvium Debug for VS Code

Under development, and I have no idea what I'm doing.

## File Associations

Add the following file association in your user `settings.json` file so that `mvms` files are interpreted by VS code as JavaScript. The microvium debugger currently registers itself as a JavaScript debugger.

```json
  "files.associations": {
    "*.mvms": "javascript"
  },
```

## Launch file

Add the following to your `.vscode/launch.json` file.

```json
{
  // Use IntelliSense to learn about possible attributes.
  // Hover to view descriptions of existing attributes.
  // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
  "version": "0.2.0",
  "configurations": [
    {
      "type": "microvium-debug",
      "request": "launch",
      "name": "Launch microvium program",
      "program": "${workspaceFolder}/app.mvms",
      "stopOnEntry": true
    },
  ]
}
```
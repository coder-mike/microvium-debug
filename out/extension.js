"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
function activate(context) {
    console.log('Activated microvium-debug');
    let disposable = vscode.commands.registerCommand('microvium-debug.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from test!');
    });
    context.subscriptions.push(disposable);
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map
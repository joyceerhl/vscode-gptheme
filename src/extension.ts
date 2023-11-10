// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { generateTheme } from 'vscode-theme-generator';
import * as vscode from 'vscode';
import * as path from 'path';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const agent = vscode.chat.createChatAgent('gptheme', async (request: vscode.ChatAgentRequest, context: vscode.ChatAgentContext, progress: vscode.Progress<vscode.ChatAgentProgress>, token: vscode.CancellationToken) => {
		const chatAccess = await vscode.chat.requestChatAccess('copilot');
		const chatRequest = chatAccess.makeRequest([
			{ role: vscode.ChatMessageRole.System, content: generateSystemPrompt()},
			{ role: vscode.ChatMessageRole.User, content: 'Generating theme...'},
			{ role: vscode.ChatMessageRole.User, content: generateUserPrompt(request.prompt)},
		], {}, token);
		let data = '';
		for await (const part of chatRequest.response) {
			data += part;
			progress.report({ content: part });
		}

		const regex = /```(json)?\n([\s\S]*?)\n?```/g;
		const match = regex.exec(data);
		const json = match ? match[2] : '';
		if (!json) {
			return { errorDetails: { message: 'Sorry, please try asking your question again.'} };
		}

		const parsed = JSON.parse(json);
		let fixedParsed = parsed;
		if (compareHexColors(parsed['foreground'], parsed['background']) < 0) {
			fixedParsed = { ...parsed, ...{ foreground: parsed['background'], background: parsed['foreground'] } };
		}

		const colorSet = { base: fixedParsed };
		generateTheme('GPTheme', colorSet, path.join(__dirname, '../theme.json'));
		return {};
	});

	agent.description = 'Generate a VS Code theme from natural language';
	agent.fullName = 'Theme Generator';
	agent.followupProvider = {
		provideFollowups: (result: vscode.ChatAgentResult2, token: vscode.CancellationToken) => {
			if (!result.errorDetails) {
				return [{ message: 'Change Theme', command: 'workbench.action.selectTheme' }];
			}
		}
	};

	context.subscriptions.push(agent);
}

const tokenNames = [
	'background',
	'foreground',
	'color1',
	'color2',
	'color3',
	'color4',
];

function generateSystemPrompt() {
	return `
You are an expert theme designer who is excellent at choosing unique and harmonious color palettes.
Generate a color palette of unique colors for a VS Code theme inspired by the user's text provided below for the following tokens. Return the theme as a JSON object where the keys are the tokens, and the values are colors in hexadecimal format. The colors should look good together and have good color contrast.
Tokens: ${tokenNames.map((token) => '"' + token + '"').join(",\n")}`;
}

function generateUserPrompt(inputText: string) {
return `
Text: ${inputText}
Tokens: ${tokenNames.map((token) => '"' + token + '"').join(",\n")}`;
}

function compareHexColors(hex1: string, hex2: string) {
    return parseInt(hex1.replace('#', ''), 16) - parseInt(hex2.replace('#', ''), 16);
}

// This method is called when your extension is deactivated
export function deactivate() {}

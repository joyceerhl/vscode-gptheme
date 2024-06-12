// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { IColorSet, generateTheme } from 'vscode-theme-generator';
import * as vscode from 'vscode';
import * as path from 'path';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('gptheme.applyTheme', (args: unknown) => {
			const colorSet = Array.isArray(args) ? (args[0] as IColorSet) : args as IColorSet;
			generateTheme('GPTheme', colorSet, path.join(__dirname, '../theme.json'));
			vscode.workspace.getConfiguration().update('workbench.colorTheme', 'GPTheme', vscode.ConfigurationTarget.Global);
		})
	);

	const agent = vscode.chat.createChatParticipant('gptheme', async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
		const messages = [
			vscode.LanguageModelChatMessage.User(generateSystemPrompt()),
			vscode.LanguageModelChatMessage.User(generateUserPrompt(request.prompt)),
		];
		const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		if (!model) {
			throw new Error('No model found');
		}

		let data = '';
		const chatResponse = await model.sendRequest(messages, {}, token);
		for await (const fragment of chatResponse.text) {
			data += fragment;
			response.markdown(fragment);
		}

		const regex = /```(json)?\n([\s\S]*?)\n?```/g;
		const match = regex.exec(data);
		const json = match ? match[2] : '';
		if (!json) {
			return { errorDetails: { message: 'Sorry, please try asking your question again.' } };
		}

		const parsed = JSON.parse(json);
		let fixedParsed = parsed;
		if (compareHexColors(parsed['foreground'], parsed['background']) < 0) {
			fixedParsed = { ...parsed, ...{ foreground: parsed['background'], background: parsed['foreground'] } };
		}

		const colorSet = { base: fixedParsed };

		response.button({ title: 'Generate and Apply Theme', command: 'gptheme.applyTheme', arguments: [colorSet] });

		return {};
	});

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
Generate a color palette of unique colors for a VS Code theme inspired by the user's text provided below for the following tokens.
Provide an explanation for the color palette that you chose, then return the theme as a JSON object where the keys are the tokens, and the values are colors in hexadecimal format. The colors should look good together and have good color contrast. Wrap the JSON object in a Markdown codeblock.
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
export function deactivate() { }

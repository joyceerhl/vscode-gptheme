// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { IColorSet, generateTheme } from 'vscode-theme-generator';
import * as vscode from 'vscode';
import * as path from 'path';
import { SpotifyAuthProvider, UpdateableAuthenticationSession } from './spotify';
import { BetterTokenStorage } from './betterSecretStorage';
import { SpotifyUriHandler } from './uriHandler';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const uriHandler = new SpotifyUriHandler();
	context.subscriptions.push(uriHandler);
	const tokenStorage = new BetterTokenStorage<UpdateableAuthenticationSession>(context.extension.id, context);
	const authProvider = new SpotifyAuthProvider(uriHandler, tokenStorage);
	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(vscode.authentication.registerAuthenticationProvider(
		SpotifyAuthProvider.id,
		SpotifyAuthProvider.label,
		authProvider
	));

	context.subscriptions.push(
		vscode.commands.registerCommand('gptheme.applyTheme', async (args: unknown) => {
			const colorSet = Array.isArray(args) ? (args[0] as IColorSet) : args as IColorSet;
			const themeFile = path.join(__dirname, '../theme.json');
			const previousThemeContents = await vscode.workspace.fs.readFile(vscode.Uri.file(themeFile));
			generateTheme('GPTheme', colorSet, themeFile);

			const config = vscode.workspace.getConfiguration();
			const settingName = 'workbench.colorTheme';
			const previousTheme = config.get<string>(settingName);

			// Hack: Clear the theme first to ensure the new theme is applied
			const setTheme = async () => {
				await config.update(settingName, undefined, vscode.ConfigurationTarget.Global);
				await config.update(settingName, 'GPTheme', vscode.ConfigurationTarget.Global);
			};
			await setTheme();

			vscode.window.showInformationMessage('Would you like to revert to your previous theme?', 'Yes', 'No')
				.then(async (value) => {
					if (value === 'Yes') {
						if (previousTheme !== 'GPTheme') {
							await config.update(settingName, previousTheme, vscode.ConfigurationTarget.Global);
						} else {
							await vscode.workspace.fs.writeFile(vscode.Uri.file(themeFile), previousThemeContents);
							await setTheme();
						}
					}
				});
		})
	);

	const agent = vscode.chat.createChatParticipant('gptheme', async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
		const additionalContext: string[] = [];

		switch (request.command) {
			case 'spotify': {
				const client = await authProvider.getSpotifyClient();
				const state = await client.player.getPlaybackState();
				if ('album' in state.item) {
					additionalContext.push(`I'm currently playing the following song: ${state.item.name} by ${state.item.artists[0].name}. Please use this as inspiration when generating a theme.`);
				}
				break;
			}
		}

		const messages = [
			vscode.LanguageModelChatMessage.User(generateSystemPrompt()),
			vscode.LanguageModelChatMessage.User(generateUserPrompt(request.prompt, additionalContext)),
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

		const regex = /```(css)?\n([\s\S]*?)\n?```/gi;
		const match = regex.exec(data);
		const css = match ? match[2] : '';
		if (!css) {
			return { errorDetails: { message: 'Sorry, please try asking your question again.' } };
		}

		const parsed = css.trim().split('\n')
			.slice(1, -1) // Strip the first and lines lines of the CSS rule
			.map(line => {
				return line.trim()
				.replace(/;$/, '')
				.split(/:\s*/);
			})
			.reduce((acc, [key, value]) => {
				acc[key] = value;
				return acc;
			}, {} as Record<string, string>);
		let fixedParsed = parsed;
		if ('foreground' in parsed && 'background' in parsed && compareHexColors(parsed['foreground'], parsed['background']) < 0) {
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
	// The #000000 note is because vscode-theme-generator tries to lighten colors to generate other colors, and it does this in a naive way that doesn't work on black.
	return `
You are an expert theme designer who is excellent at choosing unique and harmonious color palettes.
Generate a color palette of unique colors for a VS Code theme inspired by the user's text provided below for the following tokens.
First, think of a colorful scene that could be evoked by the user's prompt. Briefly describe this scene and some of the colors in it. Only use natural language in this step, no hexadecimal colors.
Then, return the theme as a CSS rule where the token names are properties (which don't really exist in CSS), and the values are colors in hexadecimal format. You can only use one rule and hex-format colors, no other CSS features. Wrap the CSS in a triple-backtick markdown codeblock. Do not include comments in the CSS rule.
This is a dark theme- the background color should be darker than the other colors.
The colors should look good together and have good color contrast.
Don't repeat the same color multiple times. Never use full black (#000000).
Tokens: ${tokenNames.map((token) => '"' + token + '"').join(",\n")}

CSS output example:
\`\`\`css
.theme {
	background: #353535;
	foreground: #FFFFFF;
	color1: #F52940;
	color2: #3D9CF5;
	color3: #9CDE38;
	color4: #FF9636;
}
\`\`\`
`;
}

function generateUserPrompt(inputText: string, additionalContext: string[]) {
	return `
Text: ${inputText}
Tokens: ${tokenNames.map((token) => '"' + token + '"').join(",\n")}
${additionalContext.join('\n')}`;
}

function compareHexColors(hex1: string, hex2: string) {
	return parseInt(hex1.replace('#', ''), 16) - parseInt(hex2.replace('#', ''), 16);
}

// This method is called when your extension is deactivated
export function deactivate() { }

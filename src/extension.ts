// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { IColorSet, generateTheme } from 'vscode-theme-generator';
import * as vscode from 'vscode';
import * as path from 'path';
import { SpotifyAuthProvider } from './spotify';
import { sendChatParticipantRequest  } from '@vscode/chat-extension-utils';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	const authProvider = new SpotifyAuthProvider(context.secrets);
	await authProvider.initialize();
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
		let prompt = request.prompt;

		switch (request.command) {
			case 'spotify': {
				const client = await authProvider.getSpotifyClient();
				const state = await client.player.getPlaybackState();
				let track = state?.item;
				if (!track) {
					const tracks = await client.player.getRecentlyPlayedTracks();
					track = tracks.items[0].track;
				}
				if ('album' in track) {
					response.progress(`Generating theme for "${track.name}" by ${track.artists[0].name}...`);
					prompt += `\nI'm currently playing the following song: ${track.name} by ${track.artists[0].name}. Please use this as inspiration when generating a theme.`;
				}
				break;
			}
			case 'random':
				prompt = await randomPrompt(token);
				response.markdown(`Prompt: "${prompt}"\n\n`);
				break;
		}


		const result = sendChatParticipantRequest(request, context,{ prompt: `${generateSystemPrompt()}\n${prompt}`}, token);


		let data = '';
		for await (const fragment of result.stream) {
			if (fragment instanceof vscode.LanguageModelTextPart) {
				data += fragment.value;
				response.markdown(fragment.value);
			}
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
	agent.iconPath = new vscode.ThemeIcon('paintcan');

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
	return `You are an expert theme designer who is excellent at choosing unique and harmonious color palettes.
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

function compareHexColors(hex1: string, hex2: string) {
	return parseInt(hex1.replace('#', ''), 16) - parseInt(hex2.replace('#', ''), 16);
}

function pickRandom<T>(list: T[]): T {
	return list[Math.floor(Math.random() * list.length)];
}

const randomPromptThemes = [
	'nature',
	'beauty',
	'art',
	'technology',
	'sports',
	'movies',
	'music',
	'magic',
	'bikes',
	'code',
	'food',
	'cities',
	''
];

async function randomPrompt(token: vscode.CancellationToken): Promise<string> {
	let [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-3.5-turbo' });
	if (!model) {
		[model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	}

	const target = pickRandom(['place', 'object', 'scene']);
	const theme = pickRandom(randomPromptThemes);
	const themePart = theme ? `Your selection can be related to "${theme}".` : '';
	const prompt = `You are assisting a software engineer. Your task is to imagine and describe a random ${target}, which a designer will use as inspiration. ${themePart} Reply with a very brief and direct one-sentence description of the ${target}. Not too much detail. No unnecessary adjectives.`;
	const chatResponse = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
	let data = '';
	for await (const fragment of chatResponse.text) {
		data += fragment;
	}

	return data;
}

// This method is called when your extension is deactivated
export function deactivate() { }

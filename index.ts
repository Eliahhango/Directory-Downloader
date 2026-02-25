// eslint-disable-next-line import/no-unassigned-import
import 'typed-query-selector';
import {
	getDirectoryContentViaContentsApi,
	getDirectoryContentViaTreesApi,
	type ListGithubDirectoryOptions,
	type TreeResponseObject,
	type ContentsReponseObject,
} from 'list-github-dir-content';
import pMap from 'p-map';
import authenticatedFetch from './authenticated-fetch.js';
import {downloadFile} from './download.js';
import getRepositoryInfo from './repository-info.js';

type ApiOptions = ListGithubDirectoryOptions & {getFullData: true};
type RepoFile = TreeResponseObject | ContentsReponseObject;

type Theme = 'forest' | 'ocean' | 'sunset';

const sampleUrl = 'https://github.com/mrdoob/three.js/tree/dev/build';
const blockedWords = /malware|virus|trojan/i;
const recentStorageKey = 'recent-directory-links';
const themeStorageKey = 'theme';
const tokenStorageKey = 'token';

const ui = {
	form: document.querySelector<HTMLFormElement>('#download-form')!,
	url: document.querySelector<HTMLInputElement>('#url')!,
	filename: document.querySelector<HTMLInputElement>('#filename')!,
	concurrency: document.querySelector<HTMLSelectElement>('#concurrency')!,
	tokenPanel: document.querySelector<HTMLDetailsElement>('#token-panel')!,
	token: document.querySelector<HTMLInputElement>('#token')!,
	toggleToken: document.querySelector<HTMLButtonElement>('#toggle-token')!,
	startButton: document.querySelector<HTMLButtonElement>('#start-button')!,
	cancelButton: document.querySelector<HTMLButtonElement>('#cancel-button')!,
	shareButton: document.querySelector<HTMLButtonElement>('#share-button')!,
	sampleButton: document.querySelector<HTMLButtonElement>('#sample-button')!,
	themeSelect: document.querySelector<HTMLSelectElement>('#theme-select')!,
	progress: document.querySelector<HTMLProgressElement>('#progress')!,
	progressLabel: document.querySelector<HTMLElement>('#progress-label')!,
	status: document.querySelector<HTMLPreElement>('#status-log')!,
	statFiles: document.querySelector<HTMLElement>('#stat-files')!,
	statDownloaded: document.querySelector<HTMLElement>('#stat-downloaded')!,
	statElapsed: document.querySelector<HTMLElement>('#stat-elapsed')!,
	recentList: document.querySelector<HTMLUListElement>('#recent-list')!,
	clearRecentButton: document.querySelector<HTMLButtonElement>('#clear-recent')!,
	clearLogButton: document.querySelector<HTMLButtonElement>('#clear-log')!,
};

const downloadState = {
	controller: undefined as AbortController | undefined,
	startedAt: 0,
	elapsedTimer: undefined as number | undefined,
	totalFiles: 0,
	downloadedFiles: 0,
};

function isError(error: unknown): error is Error {
	return error instanceof Error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function sanitizeFilename(filename: string): string {
	return filename.replaceAll(/[<>:"/\\|?*]+/g, '-').replaceAll(/\s+/g, ' ').trim();
}

function ensureZipFilename(filename: string): string {
	const cleaned = sanitizeFilename(filename);
	const safe = cleaned.length > 0 ? cleaned : 'downloaded-directory';
	return safe.endsWith('.zip') ? safe : `${safe}.zip`;
}

function saveFile(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

async function listFiles(repoListingConfig: ApiOptions): Promise<RepoFile[]> {
	const files = await getDirectoryContentViaTreesApi(repoListingConfig);
	if (!files.truncated) {
		return files;
	}

	addStatus('Large repository detected. Using fallback listing for reliability.');
	return getDirectoryContentViaContentsApi(repoListingConfig);
}

async function getZip() {
	// @ts-expect-error Dynamic import default export typing
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports, @typescript-eslint/naming-convention
	const JSZip = await import('jszip') as typeof import('jszip');
	return new JSZip();
}

function addStatus(message: string, ...extra: unknown[]) {
	const line = document.createElement('div');
	line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
	ui.status.prepend(line);
	console.log(message, ...extra);
}

function clearStatus() {
	ui.status.textContent = '';
}

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor(seconds / 60) % 60;
	const remainingSeconds = seconds % 60;
	if (hours > 0) {
		return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
	}

	return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function updateStats() {
	ui.statFiles.textContent = String(downloadState.totalFiles);
	ui.statDownloaded.textContent = String(downloadState.downloadedFiles);
	if (downloadState.startedAt === 0) {
		ui.statElapsed.textContent = '00:00';
		return;
	}

	ui.statElapsed.textContent = formatElapsed(performance.now() - downloadState.startedAt);
}

function startElapsedTimer() {
	downloadState.startedAt = performance.now();
	updateStats();
	if (downloadState.elapsedTimer !== undefined) {
		window.clearInterval(downloadState.elapsedTimer);
	}

	downloadState.elapsedTimer = window.setInterval(() => {
		updateStats();
	}, 1000);
}

function stopElapsedTimer() {
	if (downloadState.elapsedTimer !== undefined) {
		window.clearInterval(downloadState.elapsedTimer);
		downloadState.elapsedTimer = undefined;
	}
}

function setBusy(isBusy: boolean) {
	ui.startButton.disabled = isBusy;
	ui.cancelButton.disabled = !isBusy;
	ui.sampleButton.disabled = isBusy;
	ui.url.disabled = isBusy;
	ui.filename.disabled = isBusy;
	ui.concurrency.disabled = isBusy;
}

function updateProgress(label: string) {
	ui.progress.max = Math.max(downloadState.totalFiles, 1);
	ui.progress.value = downloadState.downloadedFiles;
	ui.progressLabel.textContent = label;
	updateStats();
}

function resetSession() {
	downloadState.totalFiles = 0;
	downloadState.downloadedFiles = 0;
	downloadState.startedAt = 0;
	updateProgress('Idle');
}

function parseGithubUrl(rawUrl: string): string | undefined {
	const candidate = rawUrl.trim();
	if (candidate.length === 0) {
		addStatus('Enter a GitHub directory URL first.');
		return;
	}

	const withProtocol = candidate.startsWith('http://') || candidate.startsWith('https://')
		? candidate
		: `https://${candidate}`;

	let parsed: URL;
	try {
		parsed = new URL(withProtocol);
	} catch {
		addStatus('The URL is invalid. Example: https://github.com/owner/repo/tree/main/folder');
		return;
	}

	if (!/^(?:www\.)?github\.com$/i.test(parsed.hostname)) {
		addStatus('Only github.com URLs are supported.');
		return;
	}

	parsed.hash = '';
	return parsed.toString();
}

function buildDefaultFilename(data: {
	user: string;
	repository: string;
	gitReference?: string;
	directory: string;
}): string {
	const parts = [data.user, data.repository, data.gitReference, data.directory || 'root'].filter(Boolean);
	return sanitizeFilename(parts.join('-'));
}

function parseToken() {
	const stored = localStorage.getItem(tokenStorageKey);
	if (stored) {
		ui.token.value = stored;
		ui.tokenPanel.open = true;
	}

	ui.token.addEventListener('input', () => {
		const nextToken = ui.token.value.trim();
		if (nextToken.length === 0) {
			localStorage.removeItem(tokenStorageKey);
			return;
		}

		localStorage.setItem(tokenStorageKey, nextToken);
	}, {passive: true});

	ui.toggleToken.addEventListener('click', () => {
		const reveal = ui.token.type === 'password';
		ui.token.type = reveal ? 'text' : 'password';
		ui.toggleToken.textContent = reveal ? 'Hide' : 'Show';
		ui.toggleToken.setAttribute('aria-pressed', String(reveal));
	});
}

function readRecentUrls(): string[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(recentStorageKey) ?? '[]') as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}

		return parsed.filter(item => typeof item === 'string').slice(0, 7);
	} catch {
		return [];
	}
}

function writeRecentUrls(urls: string[]) {
	localStorage.setItem(recentStorageKey, JSON.stringify(urls.slice(0, 7)));
}

function shortenUrl(value: string): string {
	return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

function renderRecentUrls() {
	const urls = readRecentUrls();
	ui.recentList.textContent = '';

	if (urls.length === 0) {
		const empty = document.createElement('li');
		empty.className = 'empty';
		empty.textContent = 'Nothing yet';
		ui.recentList.append(empty);
		return;
	}

	for (const url of urls) {
		const listItem = document.createElement('li');
		const button = document.createElement('button');
		button.type = 'button';
		button.title = url;
		button.textContent = shortenUrl(url);
		button.addEventListener('click', () => {
			ui.url.value = url;
			syncQueryParameters();
		});
		listItem.append(button);
		ui.recentList.append(listItem);
	}
}

function pushRecentUrl(url: string) {
	const urls = readRecentUrls().filter(item => item !== url);
	urls.unshift(url);
	writeRecentUrls(urls);
	renderRecentUrls();
}

function applyTheme(theme: Theme) {
	document.documentElement.dataset['theme'] = theme;
	ui.themeSelect.value = theme;
	localStorage.setItem(themeStorageKey, theme);
}

function parseTheme() {
	const stored = localStorage.getItem(themeStorageKey);
	if (stored === 'forest' || stored === 'ocean' || stored === 'sunset') {
		applyTheme(stored);
	} else {
		applyTheme('forest');
	}

	ui.themeSelect.addEventListener('change', () => {
		applyTheme(ui.themeSelect.value as Theme);
	});
}

function buildShareUrl(): string | undefined {
	const normalizedUrl = parseGithubUrl(ui.url.value);
	if (!normalizedUrl) {
		return;
	}

	const shareUrl = new URL(location.href);
	shareUrl.searchParams.set('url', normalizedUrl);
	const filename = ui.filename.value.trim();
	if (filename.length > 0) {
		shareUrl.searchParams.set('filename', filename);
	} else {
		shareUrl.searchParams.delete('filename');
	}

	return shareUrl.toString();
}

function syncQueryParameters() {
	const current = new URL(location.href);
	const url = parseGithubUrl(ui.url.value);
	if (url) {
		current.searchParams.set('url', url);
	} else {
		current.searchParams.delete('url');
	}

	const filename = ui.filename.value.trim();
	if (filename.length > 0) {
		current.searchParams.set('filename', filename);
	} else {
		current.searchParams.delete('filename');
	}

	history.replaceState(undefined, '', `${current.pathname}${current.search}`);
}

function parseErrorMessage(error: string): string {
	switch (error) {
		case 'NOT_A_REPOSITORY': {
			return 'Not a repository URL.';
		}

		case 'NOT_A_DIRECTORY': {
			return 'That URL points to a file, not a directory.';
		}

		case 'REPOSITORY_NOT_FOUND': {
			return 'Repository not found. If it is private, provide a valid token.';
		}

		case 'BRANCH_NOT_FOUND': {
			return 'Branch or tag could not be resolved.';
		}

		default: {
			return 'Unknown repository parsing error.';
		}
	}
}

async function downloadFullRepository(options: {
	signal: AbortSignal;
	user: string;
	repository: string;
	gitReference?: string;
	downloadUrl: string;
	isPrivate: boolean;
}) {
	const filenameFromInput = ui.filename.value.trim();
	const defaultName = buildDefaultFilename({
		user: options.user,
		repository: options.repository,
		gitReference: options.gitReference,
		directory: '',
	});
	const zipName = ensureZipFilename(filenameFromInput || defaultName);

	if (options.isPrivate) {
		addStatus('Downloading private repository archive with token.');
		const response = await authenticatedFetch(options.downloadUrl, {signal: options.signal});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} while downloading archive`);
		}

		const blob = await response.blob();
		downloadState.totalFiles = 1;
		downloadState.downloadedFiles = 1;
		updateProgress('Archive downloaded');
		saveFile(blob, zipName);
		addStatus(`Saved ${zipName}`);
		return;
	}

	if (filenameFromInput.length > 0) {
		addStatus('Note: GitHub controls the filename for public repository archives.');
	}

	downloadState.totalFiles = 1;
	downloadState.downloadedFiles = 1;
	updateProgress('Starting archive download in browser...');
	window.location.assign(options.downloadUrl);
	addStatus('GitHub archive download started in a new request.');
}

async function downloadDirectory(options: {
	signal: AbortSignal;
	user: string;
	repository: string;
	gitReference: string;
	directory: string;
	isPrivate: boolean;
}) {
	addStatus('Retrieving directory file list...');
	const files = await listFiles({
		user: options.user,
		repository: options.repository,
		ref: options.gitReference,
		directory: options.directory,
		token: localStorage.getItem(tokenStorageKey) ?? undefined,
		getFullData: true,
	});

	if (files.length === 0) {
		downloadState.totalFiles = 0;
		downloadState.downloadedFiles = 0;
		updateProgress('No files in this directory');
		addStatus('No files found.');
		return;
	}

	if (files.some(file => blockedWords.test(file.path))) {
		throw new Error('Suspicious filename found. Download canceled.');
	}

	downloadState.totalFiles = files.length;
	downloadState.downloadedFiles = 0;
	updateProgress(`Found ${files.length} files`);

	const zipPromise = getZip();
	const concurrency = Number.parseInt(ui.concurrency.value, 10);
	const safeConcurrency = Number.isNaN(concurrency) ? 20 : Math.max(1, Math.min(40, concurrency));
	addStatus(`Downloading ${files.length} files with concurrency ${safeConcurrency}...`);

	try {
		await pMap(files, async file => {
			const blob = await downloadFile({
				user: options.user,
				repository: options.repository,
				reference: options.gitReference,
				file,
				isPrivate: options.isPrivate,
				signal: options.signal,
			});

			const zip = await zipPromise;
			const relativePath = options.directory ? file.path.replace(`${options.directory}/`, '') : file.path;
			zip.file(relativePath, blob, {binary: true});

			downloadState.downloadedFiles++;
			updateProgress(`Downloaded ${downloadState.downloadedFiles}/${downloadState.totalFiles}`);
		}, {concurrency: safeConcurrency});
	} catch (error) {
		if (options.signal.aborted || isAbortError(error)) {
			throw new DOMException('Canceled', 'AbortError');
		}

		if (!navigator.onLine) {
			throw new Error('Network connection was lost while downloading files.');
		}

		if (isError(error) && error.message.startsWith('HTTP ')) {
			throw new Error('One or more files could not be downloaded from GitHub.');
		}

		throw error;
	}

	addStatus('Creating zip archive...');
	const zip = await zipPromise;
	const zipBlob = await zip.generateAsync({type: 'blob'});
	const fallbackName = buildDefaultFilename({
		user: options.user,
		repository: options.repository,
		gitReference: options.gitReference,
		directory: options.directory,
	});
	const filename = ensureZipFilename(ui.filename.value.trim() || fallbackName);
	saveFile(zipBlob, filename);
	updateProgress('Download complete');
	addStatus(`Saved ${filename}`);
}

async function startDownload() {
	const normalizedUrl = parseGithubUrl(ui.url.value);
	if (!normalizedUrl) {
		return;
	}

	if (blockedWords.test(normalizedUrl)) {
		addStatus('Blocked keywords detected in URL.');
		return;
	}

	if (!navigator.onLine) {
		addStatus('You are offline. Connect to the internet and retry.');
		return;
	}

	clearStatus();
	syncQueryParameters();
	setBusy(true);
	startElapsedTimer();
	addStatus('Preparing download request...');
	updateProgress('Validating repository URL...');

	const controller = new AbortController();
	downloadState.controller = controller;

	try {
		const parsedPath = await getRepositoryInfo(normalizedUrl);
		if ('error' in parsedPath) {
			addStatus(parseErrorMessage(parsedPath.error));
			return;
		}

		const {user, repository, directory, isPrivate} = parsedPath;
		addStatus(`Repository: ${user}/${repository}`);
		addStatus(`Directory: /${directory || '(root)'}`);
		pushRecentUrl(normalizedUrl);

		if ('downloadUrl' in parsedPath) {
			await downloadFullRepository({
				signal: controller.signal,
				user,
				repository,
				gitReference: parsedPath.gitReference,
				downloadUrl: parsedPath.downloadUrl,
				isPrivate,
			});
			return;
		}

		await downloadDirectory({
			signal: controller.signal,
			user,
			repository,
			gitReference: parsedPath.gitReference,
			directory,
			isPrivate,
		});
	} catch (error) {
		if (downloadState.controller?.signal.aborted || isAbortError(error)) {
			addStatus('Download canceled by user.');
			updateProgress('Canceled');
			return;
		}

		if (isError(error)) {
			switch (error.message) {
				case 'Invalid token': {
					addStatus('The token is invalid or revoked.');
					break;
				}

				case 'Rate limit exceeded': {
					addStatus('GitHub rate limit exceeded. Add token or wait and retry.');
					break;
				}

				default: {
					addStatus(`Error: ${error.message}`);
					break;
				}
			}
		}
	} finally {
		stopElapsedTimer();
		updateStats();
		setBusy(false);
		downloadState.controller = undefined;
	}
}

async function copyShareLink() {
	const shareUrl = buildShareUrl();
	if (!shareUrl) {
		return;
	}

	try {
		await navigator.clipboard.writeText(shareUrl);
		addStatus('Share link copied to clipboard.');
	} catch {
		addStatus('Could not copy to clipboard. You can copy from the browser URL bar.');
	}
}

function wireEvents() {
	ui.form.addEventListener('submit', event => {
		event.preventDefault();
		void startDownload();
	});

	ui.cancelButton.addEventListener('click', () => {
		downloadState.controller?.abort();
	});

	ui.shareButton.addEventListener('click', () => {
		void copyShareLink();
	});

	ui.sampleButton.addEventListener('click', () => {
		ui.url.value = sampleUrl;
		syncQueryParameters();
		ui.url.focus();
	});

	ui.url.addEventListener('change', () => {
		syncQueryParameters();
	});

	ui.filename.addEventListener('change', () => {
		syncQueryParameters();
	});

	ui.clearLogButton.addEventListener('click', () => {
		clearStatus();
		addStatus('Log cleared.');
	});

	ui.clearRecentButton.addEventListener('click', () => {
		writeRecentUrls([]);
		renderRecentUrls();
		addStatus('Recent URL history cleared.');
	});

	document.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			downloadState.controller?.abort();
		}

		if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
			event.preventDefault();
			void startDownload();
		}
	});
}

function hydrateFromQuery() {
	const query = new URLSearchParams(location.search);
	const url = query.get('url');
	const filename = query.get('filename');
	if (url) {
		ui.url.value = url;
	}

	if (filename) {
		ui.filename.value = filename;
	}

	if (url) {
		addStatus('URL detected in query parameters. Auto-starting download...');
		void startDownload();
	}
}

function init() {
	resetSession();
	parseToken();
	parseTheme();
	renderRecentUrls();
	wireEvents();
	hydrateFromQuery();
	if (ui.status.textContent === '') {
		addStatus('Ready. Paste a GitHub folder URL and press Download directory.');
	}
}

init();

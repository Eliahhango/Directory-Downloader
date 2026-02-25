import {type DragEvent, type FormEvent, useEffect, useMemo, useRef, useState} from 'react';
import {motion} from 'framer-motion';
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

type QueueItem = {
	url: string;
	filename?: string;
	filter?: string;
};

const sampleUrl = 'https://github.com/mrdoob/three.js/tree/dev/build';
const blockedWords = /malware|virus|trojan/i;
const recentStorageKey = 'recent-directory-links';
const tokenStorageKey = 'token';

const motionEase = [0.16, 1, 0.3, 1] as const;

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

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '--';
	}

	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index++;
	}

	return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function parseGithubUrl(rawUrl: string): string | undefined {
	const candidate = rawUrl.trim();
	if (candidate.length === 0) {
		return;
	}

	const withProtocol = candidate.startsWith('http://') || candidate.startsWith('https://')
		? candidate
		: `https://${candidate}`;

	let parsed: URL;
	try {
		parsed = new URL(withProtocol);
	} catch {
		return;
	}

	if (!/^(?:www\.)?github\.com$/i.test(parsed.hostname)) {
		return;
	}

	parsed.hash = '';
	return parsed.toString();
}

function parseUrlList(rawValue: string): string[] {
	return rawValue
		.split(/\r?\n|,|\s+/)
		.map(value => value.trim())
		.filter(value => value.length > 0)
		.map(value => parseGithubUrl(value))
		.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function parseFilter(value: string): string[] {
	return value
		.split(',')
		.map(entry => entry.trim().toLowerCase())
		.filter(entry => entry.length > 0)
		.map(entry => (entry.startsWith('.') ? entry : `.${entry}`));
}

function filterFiles(files: RepoFile[], extensions: string[]): RepoFile[] {
	if (extensions.length === 0) {
		return files;
	}

	return files.filter(file => extensions.some(extension => file.path.toLowerCase().endsWith(extension)));
}

function estimateBytes(files: RepoFile[]): number {
	let total = 0;
	for (const file of files) {
		if (typeof file.size === 'number') {
			total += file.size;
		}
	}

	return total;
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

function saveFile(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

async function getZip() {
	// @ts-expect-error Dynamic import default export typing
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports, @typescript-eslint/naming-convention
	const JSZip = await import('jszip') as typeof import('jszip');
	return new JSZip();
}

async function listFiles(repoListingConfig: ApiOptions): Promise<RepoFile[]> {
	const files = await getDirectoryContentViaTreesApi(repoListingConfig);
	if (!files.truncated) {
		return files;
	}

	return getDirectoryContentViaContentsApi(repoListingConfig);
}

export default function App() {
	const [urlText, setUrlText] = useState('');
	const [filename, setFilename] = useState('');
	const [filterText, setFilterText] = useState('');
	const [concurrency, setConcurrency] = useState('20');
	const [token, setToken] = useState('');
	const [tokenPanelOpen, setTokenPanelOpen] = useState(false);
	const [tokenVisible, setTokenVisible] = useState(false);
	const [statusLines, setStatusLines] = useState<string[]>([]);
	const [recentUrls, setRecentUrls] = useState<string[]>([]);
	const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
	const [failedFiles, setFailedFiles] = useState<string[]>([]);
	const [totalFiles, setTotalFiles] = useState(0);
	const [downloadedFiles, setDownloadedFiles] = useState(0);
	const [estimatedBytes, setEstimatedBytes] = useState(0);
	const [elapsed, setElapsed] = useState('00:00');
	const [progressLabel, setProgressLabel] = useState('Idle');
	const [isBusy, setIsBusy] = useState(false);

	const controllerRef = useRef<AbortController | null>(null);
	const startedAtRef = useRef<number>(0);
	const elapsedTimerRef = useRef<number | null>(null);
	const queueRef = useRef<QueueItem[]>([]);
	const isProcessingQueueRef = useRef(false);

	useEffect(() => {
		queueRef.current = queueItems;
	}, [queueItems]);

	useEffect(() => {
		const storedToken = localStorage.getItem(tokenStorageKey);
		if (storedToken) {
			setToken(storedToken);
			setTokenPanelOpen(true);
		}

		const storedRecent = localStorage.getItem(recentStorageKey);
		if (storedRecent) {
			try {
				const parsed = JSON.parse(storedRecent) as unknown;
				if (Array.isArray(parsed)) {
					setRecentUrls(parsed.filter(item => typeof item === 'string').slice(0, 7));
				}
			} catch {
				// Ignore malformed storage.
			}
		}
	}, []);

	useEffect(() => {
		if (token.length === 0) {
			localStorage.removeItem(tokenStorageKey);
		} else {
			localStorage.setItem(tokenStorageKey, token);
		}
	}, [token]);

	const formattedEstimate = useMemo(() => formatBytes(estimatedBytes), [estimatedBytes]);

	const addStatus = (message: string) => {
		const entry = `[${new Date().toLocaleTimeString()}] ${message}`;
		setStatusLines(prev => [entry, ...prev]);
	};

	const clearStatus = () => {
		setStatusLines([]);
	};

	const updateElapsed = () => {
		if (!startedAtRef.current) {
			setElapsed('00:00');
			return;
		}

		const ms = performance.now() - startedAtRef.current;
		const seconds = Math.floor(ms / 1000);
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor(seconds / 60) % 60;
		const remainingSeconds = seconds % 60;
		if (hours > 0) {
			setElapsed(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`);
			return;
		}

		setElapsed(`${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`);
	};

	const startElapsedTimer = () => {
		startedAtRef.current = performance.now();
		updateElapsed();
		if (elapsedTimerRef.current) {
			window.clearInterval(elapsedTimerRef.current);
		}

		elapsedTimerRef.current = window.setInterval(() => {
			updateElapsed();
		}, 1000);
	};

	const stopElapsedTimer = () => {
		if (elapsedTimerRef.current) {
			window.clearInterval(elapsedTimerRef.current);
			elapsedTimerRef.current = null;
		}
	};

	const resetSession = () => {
		setTotalFiles(0);
		setDownloadedFiles(0);
		setEstimatedBytes(0);
		setFailedFiles([]);
		setProgressLabel('Idle');
	};

	const clearAll = (message?: string) => {
		controllerRef.current?.abort();
		controllerRef.current = null;
		stopElapsedTimer();
		resetSession();
		clearStatus();
		setUrlText('');
		setFilename('');
		setFilterText('');
		setToken('');
		setTokenVisible(false);
		setTokenPanelOpen(false);
		localStorage.removeItem(tokenStorageKey);
		localStorage.removeItem(recentStorageKey);
		setRecentUrls([]);
		setQueueItems([]);
		queueRef.current = [];
		setIsBusy(false);
		if (message) {
			addStatus(message);
		}
	};

	const pushRecentUrl = (url: string) => {
		setRecentUrls(prev => {
			const next = [url, ...prev.filter(item => item !== url)].slice(0, 7);
			localStorage.setItem(recentStorageKey, JSON.stringify(next));
			return next;
		});
	};

	const buildShareUrl = () => {
		const urls = parseUrlList(urlText);
		const firstUrl = urls[0];
		if (!firstUrl) {
			addStatus('Enter at least one GitHub directory URL first.');
			return;
		}

		const shareUrl = new URL(location.href);
		shareUrl.searchParams.set('url', firstUrl);
		if (filename.trim()) {
			shareUrl.searchParams.set('filename', filename.trim());
		} else {
			shareUrl.searchParams.delete('filename');
		}

		return shareUrl.toString();
	};

	const copyShareLink = async () => {
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
	};

	const pasteFromClipboard = async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (text) {
				setUrlText(text);
				addStatus('Clipboard content pasted into the URL box.');
			}
		} catch {
			addStatus('Clipboard access denied. Paste manually instead.');
		}
	};

	const handleDrop = (event: DragEvent<HTMLTextAreaElement>) => {
		event.preventDefault();
		const text = event.dataTransfer.getData('text/plain');
		if (text) {
			setUrlText(text);
			addStatus('Dropped content added to the URL box.');
		}
	};

	const downloadFullRepository = async (options: {
		signal: AbortSignal;
		user: string;
		repository: string;
		gitReference?: string;
		downloadUrl: string;
		isPrivate: boolean;
	}) => {
		const filenameFromInput = filename.trim();
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
			setTotalFiles(1);
			setDownloadedFiles(1);
			setProgressLabel('Archive downloaded');
			saveFile(blob, zipName);
			addStatus(`Saved ${zipName}`);
			return;
		}

		if (filenameFromInput.length > 0) {
			addStatus('Note: GitHub controls the filename for public repository archives.');
		}

		setTotalFiles(1);
		setDownloadedFiles(1);
		setProgressLabel('Starting archive download in browser...');
		window.location.assign(options.downloadUrl);
		addStatus('GitHub archive download started in a new request.');
	};

	const downloadDirectory = async (options: {
		signal: AbortSignal;
		user: string;
		repository: string;
		gitReference: string;
		directory: string;
		isPrivate: boolean;
		filter: string[];
	}) => {
		addStatus('Retrieving directory file list...');
		const files = await listFiles({
			user: options.user,
			repository: options.repository,
			ref: options.gitReference,
			directory: options.directory,
			token: token || undefined,
			getFullData: true,
		});

		if (files.length === 0) {
			setTotalFiles(0);
			setDownloadedFiles(0);
			setProgressLabel('No files in this directory');
			addStatus('No files found.');
			return;
		}

		const filteredFiles = filterFiles(files, options.filter);
		if (filteredFiles.length === 0) {
			addStatus('No files matched the selected filter.');
			return;
		}

		if (filteredFiles.some(file => blockedWords.test(file.path))) {
			throw new Error('Suspicious filename found. Download canceled.');
		}

		setTotalFiles(filteredFiles.length);
		setDownloadedFiles(0);
		setEstimatedBytes(estimateBytes(filteredFiles));
		setProgressLabel(`Found ${filteredFiles.length} files`);

		const zipPromise = getZip();
		const parsedConcurrency = Number.parseInt(concurrency, 10);
		const safeConcurrency = Number.isNaN(parsedConcurrency) ? 20 : Math.max(1, Math.min(40, parsedConcurrency));
		addStatus(`Downloading ${filteredFiles.length} files with concurrency ${safeConcurrency}...`);

		let failures: string[] = [];
		setFailedFiles([]);

		const downloadBatch = async (batch: RepoFile[], label: string) => {
			addStatus(label);
			await pMap(batch, async file => {
				try {
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

					setDownloadedFiles(current => {
						const next = current + 1;
						setProgressLabel(`Downloaded ${next}/${filteredFiles.length}`);
						return next;
					});
				} catch (error) {
					if (options.signal.aborted || isAbortError(error)) {
						throw error;
					}

					failures = [...failures, file.path];
					setFailedFiles([...failures]);
				}
			}, {concurrency: safeConcurrency});
		};

		try {
			await downloadBatch(filteredFiles, 'Downloading files...');
			if (failures.length > 0) {
				const retryTargets = filteredFiles.filter(file => failures.includes(file.path));
				failures = [];
				setFailedFiles([]);
				await downloadBatch(retryTargets, 'Retrying failed files...');
			}
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
		const zipFilename = ensureZipFilename(filename.trim() || fallbackName);
		saveFile(zipBlob, zipFilename);
		setProgressLabel('Download complete');
		addStatus(`Saved ${zipFilename}`);
	};

	const runDownload = async (rawUrl: string, filenameOverride?: string, filterOverride?: string) => {
		const normalizedUrl = parseGithubUrl(rawUrl);
		if (!normalizedUrl) {
			addStatus(`Invalid URL skipped: ${rawUrl}`);
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
		setIsBusy(true);
		startElapsedTimer();
		addStatus('Preparing download request...');
		setProgressLabel('Validating repository URL...');

		const controller = new AbortController();
		controllerRef.current = controller;

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

			if (isPrivate && !token) {
				setTokenPanelOpen(true);
				addStatus('Private repository detected. Please add a token to continue.');
				return;
			}

			if ('downloadUrl' in parsedPath) {
				if (filenameOverride) {
					setFilename(filenameOverride);
				}

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

			if (filenameOverride) {
				setFilename(filenameOverride);
			}

			const filter = filterOverride ? parseFilter(filterOverride) : parseFilter(filterText);
			await downloadDirectory({
				signal: controller.signal,
				user,
				repository,
				gitReference: parsedPath.gitReference,
				directory,
				isPrivate,
				filter,
			});
		} catch (error) {
			if (controller.signal.aborted || isAbortError(error)) {
				addStatus('Download canceled by user.');
				setProgressLabel('Canceled');
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
			} else {
				addStatus('Unexpected error occurred. Please retry.');
			}
		} finally {
			stopElapsedTimer();
			updateElapsed();
			setIsBusy(false);
			controllerRef.current = null;
		}
	};

	const processQueue = async () => {
		if (isProcessingQueueRef.current) {
			return;
		}

		isProcessingQueueRef.current = true;
		while (queueRef.current.length > 0) {
			const item = queueRef.current[0];
			queueRef.current = queueRef.current.slice(1);
			setQueueItems(queueRef.current);

			if (!item) {
				break;
			}

			// eslint-disable-next-line no-await-in-loop -- Sequential queue processing is intentional
			await runDownload(item.url, item.filename, item.filter);
		}

		isProcessingQueueRef.current = false;
	};

	const addToQueue = () => {
		const urls = parseUrlList(urlText);
		if (urls.length === 0) {
			addStatus('Enter at least one valid GitHub URL.');
			return;
		}

		const nextItems = urls.map(url => ({
			url,
			filename: filename.trim() || undefined,
			filter: filterText.trim() || undefined,
		}));

		setQueueItems(prev => {
			const merged = [...prev, ...nextItems];
			queueRef.current = merged;
			return merged;
		});
		addStatus(`Added ${urls.length} URL(s) to the queue.`);
	};

	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		addToQueue();
		processQueue().catch(error => {
			console.error(error);
		});
	};

	const clearQueue = () => {
		queueRef.current = [];
		setQueueItems([]);
		addStatus('Queue cleared.');
	};

	const clearRecent = () => {
		localStorage.removeItem(recentStorageKey);
		setRecentUrls([]);
		addStatus('Recent URL history cleared.');
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
			event.preventDefault();
			addToQueue();
			processQueue().catch(error => {
				console.error(error);
			});
		}
	};

	useEffect(() => {
		const query = new URLSearchParams(location.search);
		const url = query.get('url');
		const filenameParam = query.get('filename');
		if (url) {
			setUrlText(url);
			setFilename(filenameParam ?? '');
			addStatus('URL detected in query parameters. Auto-starting download...');
			runDownload(url, filenameParam ?? undefined, undefined).catch(error => {
				console.error(error);
			});
		}
	}, []);

	return (
		<div className="page">
			<motion.header
				className="site-header"
				initial={{opacity: 0, y: -20}}
				animate={{opacity: 1, y: 0}}
				transition={{duration: 0.6, ease: motionEase}}
			>
				<div className="brand">
					<span className="brand-name">Directory Downloader</span>
					<span className="brand-subtitle">Zip any GitHub folder, fast.</span>
				</div>
				<nav className="nav">
					<a href="#download">Download</a>
					<a href="#queue">Queue</a>
					<a href="#session">Session</a>
					<a href="#activity">Activity</a>
					<a href="#about">About</a>
				</nav>
				<div className="header-actions">
					<a className="source-link" href="https://github.com/Eliahhango/Directory-Downloader" target="_blank" rel="noreferrer">Source</a>
				</div>
			</motion.header>

			<main className="hero" id="download">
				<motion.section
					className="hero-copy"
					initial={{opacity: 0, y: 24}}
					animate={{opacity: 1, y: 0}}
					transition={{duration: 0.7, ease: motionEase}}
				>
					<div className="eyebrow">Ultimate GitHub Folder Utility</div>
					<h1>Ultimate Directory Downloader UI</h1>
					<p>
						Paste any GitHub directory URL and get a clean zip instantly. Works for public
						repositories and private repos with a token.
					</p>
					<div className="hero-actions">
						<button id="start-button" className="btn btn-primary" type="submit" form="download-form" disabled={isBusy}>
							<span className="btn-icon" aria-hidden="true">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M12 3v12"></path>
									<path d="M7 10l5 5 5-5"></path>
									<path d="M5 21h14"></path>
								</svg>
							</span>
							Download directory
						</button>
						<button id="share-button" className="btn btn-ghost" type="button" onClick={() => {
							copyShareLink().catch(error => {
								console.error(error);
							});
						}}>
							<span className="btn-icon" aria-hidden="true">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M10 13a5 5 0 0 1 0-7l1.5-1.5a5 5 0 0 1 7 7L17 12"></path>
									<path d="M14 11a5 5 0 0 1 0 7L12.5 19.5a5 5 0 0 1-7-7L7 11"></path>
								</svg>
							</span>
							Copy share link
						</button>
					</div>
					<div className="hero-meta">
						<span>Tip: Ctrl/Command + Enter starts instantly.</span>
					</div>
					<motion.div
						className="inspiration-card"
						id="about"
						initial={{opacity: 0, y: 16}}
						whileInView={{opacity: 1, y: 0}}
						viewport={{once: true, amount: 0.4}}
						transition={{duration: 0.5, ease: motionEase}}
					>
						<h3>Inspired by EliTechWiz</h3>
						<p>
							Cybersecurity expert, software architect, and creative designer. I focus on building secure
							systems that feel effortless to use.
						</p>
					</motion.div>
					<motion.div
						className="testimonial-card"
						initial={{opacity: 0, y: 16}}
						whileInView={{opacity: 1, y: 0}}
						viewport={{once: true, amount: 0.4}}
						transition={{duration: 0.5, ease: motionEase, delay: 0.05}}
					>
						<p>
							"The fastest way I have found to package a subfolder and move on."
						</p>
						<div className="testimonial-author">
							<div className="avatar">EW</div>
							<div>
								<strong>EliTechWiz</strong>
								<span>Security and Systems</span>
							</div>
						</div>
					</motion.div>
					<motion.div
						className="left-stack"
						initial={{opacity: 0, y: 16}}
						whileInView={{opacity: 1, y: 0}}
						viewport={{once: true, amount: 0.2}}
						transition={{duration: 0.5, ease: motionEase, delay: 0.1}}
					>
						<div className="info-card">
							<h3>Workflow</h3>
							<ol>
								<li>Paste a GitHub folder URL.</li>
								<li>Pick speed and optional filters.</li>
								<li>Download a clean zip.</li>
							</ol>
						</div>
						<div className="info-card">
							<h3>Why it is fast</h3>
							<p>Parallel file fetch, automatic retries, and streaming zip creation.</p>
						</div>
						<div className="metric-strip">
							<div>
								<strong>Queue</strong>
								<span>Batch multiple links</span>
							</div>
							<div>
								<strong>Filters</strong>
								<span>Limit file types</span>
							</div>
							<div>
								<strong>Secure</strong>
								<span>Token stays local</span>
							</div>
						</div>
					</motion.div>
				</motion.section>

				<motion.section
					className="hero-panels"
					initial={{opacity: 0, y: 24}}
					animate={{opacity: 1, y: 0}}
					transition={{duration: 0.7, ease: motionEase, delay: 0.1}}
				>
					<div className="panel-card form-card">
						<form id="download-form" onSubmit={onSubmit} onKeyDown={onKeyDown}>
							<label htmlFor="url">GitHub directory URL or URLs (one per line)</label>
							<div className="input-row">
								<textarea
									id="url"
									name="url"
									rows={3}
									placeholder="https://github.com/owner/repo/tree/branch/folder"
									required
									value={urlText}
									onChange={event => setUrlText(event.target.value)}
									onDrop={handleDrop}
									onDragOver={event => event.preventDefault()}
									disabled={isBusy}
								/>
								<button id="sample-button" type="button" onClick={() => setUrlText(sampleUrl)} disabled={isBusy}>Example</button>
							</div>
							<div className="input-row">
								<button id="paste-button" className="btn btn-soft" type="button" onClick={() => {
									pasteFromClipboard().catch(error => {
										console.error(error);
									});
								}} disabled={isBusy}>
									<span className="btn-icon" aria-hidden="true">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M8 4h8l2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"></path>
											<path d="M9 12h6"></path>
											<path d="M9 16h6"></path>
										</svg>
									</span>
									Paste from clipboard
								</button>
								<button id="add-queue" className="btn btn-primary" type="button" onClick={addToQueue} disabled={isBusy}>
									<span className="btn-icon" aria-hidden="true">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M12 5v14"></path>
											<path d="M5 12h14"></path>
										</svg>
									</span>
									Add to queue
								</button>
							</div>
							<p className="hint">
								Paste a URL like
								<code>https://github.com/mrdoob/three.js/tree/dev/build</code>. Drag and drop also works.
							</p>
							<div className="grid-two">
								<div>
									<label htmlFor="filename">Output filename (optional)</label>
									<input
										id="filename"
										name="filename"
										type="text"
										placeholder="my-folder-backup"
										value={filename}
										onChange={event => setFilename(event.target.value)}
										disabled={isBusy}
									/>
								</div>
								<div>
									<label htmlFor="concurrency">Download speed</label>
									<select
										id="concurrency"
										name="concurrency"
										value={concurrency}
										onChange={event => setConcurrency(event.target.value)}
										disabled={isBusy}
									>
										<option value="8">Steady (8)</option>
										<option value="20">Fast (20)</option>
										<option value="30">Very fast (30)</option>
									</select>
								</div>
							</div>
							<label htmlFor="filter">File type filter (comma-separated, optional)</label>
							<input
								id="filter"
								name="filter"
								type="text"
								placeholder=".ts, .js, .md"
								value={filterText}
								onChange={event => setFilterText(event.target.value)}
								disabled={isBusy}
							/>
							<details id="token-panel" open={tokenPanelOpen} onToggle={event => setTokenPanelOpen((event.target as HTMLDetailsElement).open)}>
								<summary>Private repositories (GitHub token)</summary>
								<label htmlFor="token">Personal access token</label>
								<div className="input-row">
									<input
										id="token"
										name="token"
										type={tokenVisible ? 'text' : 'password'}
										placeholder="ghp_..."
										autoComplete="off"
										pattern="[\da-f]{40}|ghp_.+|gho_.+|github_pat_.+"
										value={token}
										onChange={event => setToken(event.target.value)}
										disabled={isBusy}
									/>
									<button
										id="toggle-token"
										type="button"
										aria-pressed={tokenVisible}
										onClick={() => setTokenVisible(value => !value)}
										disabled={isBusy}
									>
										{tokenVisible ? 'Hide' : 'Show'}
									</button>
								</div>
								<p className="hint">Stored only in your local browser storage.</p>
							</details>
							<div className="actions">
								<button id="cancel-button" className="btn btn-danger" type="button" disabled={!isBusy} onClick={() => clearAll('Download canceled. Ready for a new request.')}>
									<span className="btn-icon" aria-hidden="true">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M18 6L6 18"></path>
											<path d="M6 6l12 12"></path>
										</svg>
									</span>
								Cancel
								</button>
								<button id="clear-log" className="btn btn-ghost" type="button" onClick={() => clearAll('All fields cleared. Ready for a new request.')}>
									<span className="btn-icon" aria-hidden="true">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M3 6h18"></path>
											<path d="M8 6V4h8v2"></path>
											<path d="M6 6l1 14h10l1-14"></path>
										</svg>
									</span>
								Clear all
								</button>
							</div>
						</form>
					</div>

					<div className="panel-card queue-card" id="queue">
						<div className="card-head">
							<h2>Queue</h2>
							<div className="queue-actions">
								<button id="clear-queue" className="btn btn-ghost" type="button" onClick={clearQueue}>
									<span className="btn-icon" aria-hidden="true">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M3 6h18"></path>
											<path d="M10 6v10"></path>
											<path d="M14 6v10"></path>
										</svg>
									</span>
								Clear queue
								</button>
							</div>
						</div>
						<ul className="queue-list">
							{queueItems.length === 0 ? (
								<li className="empty">Queue is empty</li>
							) : (
								queueItems.map((item, index) => (
									<li key={`${item.url}-${index}`}>{`${index + 1}. ${item.url}`}</li>
								))
							)}
						</ul>
					</div>

					<div className="panel-card session-card" id="session">
						<div className="card-head">
							<h2>Session</h2>
							<button id="clear-recent" className="btn btn-ghost" type="button" onClick={clearRecent}>
								<span className="btn-icon" aria-hidden="true">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="M12 8v4l3 2"></path>
										<path d="M3 12a9 9 0 1 0 3-6.7"></path>
										<path d="M3 5v4h4"></path>
									</svg>
								</span>
							Clear recent
							</button>
						</div>
						<div className="stats">
							<article>
								<strong>{totalFiles}</strong>
								<span>Files found</span>
							</article>
							<article>
								<strong>{downloadedFiles}</strong>
								<span>Files downloaded</span>
							</article>
							<article>
								<strong>{elapsed}</strong>
								<span>Elapsed</span>
							</article>
						</div>
						<div className="stats">
							<article>
								<strong>{formattedEstimate}</strong>
								<span>Estimated size</span>
							</article>
							<article>
								<strong>{failedFiles.length}</strong>
								<span>Failed files</span>
							</article>
						</div>
						<div className="progress-wrap">
							<progress value={downloadedFiles} max={Math.max(totalFiles, 1)}></progress>
							<div id="progress-label">{progressLabel}</div>
						</div>
						<div className="recents">
							<h3>Recent URLs</h3>
							<ul className="recent-list">
								{recentUrls.length === 0 ? (
									<li className="empty">Nothing yet</li>
								) : (
									recentUrls.map(url => (
										<li key={url}>
											<button type="button" onClick={() => setUrlText(url)}>{url}</button>
										</li>
									))
								)}
							</ul>
						</div>
					</div>

					<div className="panel-card log-card" id="activity">
						<div className="card-head">
							<h2>Activity</h2>
							<span className="log-hint">Latest events appear first.</span>
						</div>
						<pre className="status" aria-live="polite">
							{statusLines.map((line, index) => (
								<div key={`${line}-${index}`}>{line}</div>
							))}
						</pre>
						<div className="failure-list">
							<h3>Failed files</h3>
							<ul id="failure-list">
								{failedFiles.length === 0 ? (
									<li className="empty">None</li>
								) : (
									failedFiles.slice(0, 15).map(file => (
										<li key={file}>{file}</li>
									))
								)}
							</ul>
						</div>
					</div>
				</motion.section>
			</main>

			<footer className="site-footer">
				<div>
					<p>
						No content is hosted on this website. Files are fetched directly from GitHub using the URL you provide.
					</p>
					<p>
						Built by <a href="https://www.elitechwiz.site" target="_blank" rel="noreferrer">EliTechWiz</a>
					</p>
				</div>
				<div className="footer-links">
					<a href="#download">Back to top</a>
					<a href="https://github.com/settings/tokens/new?description=Directory%20Downloader&scopes=repo" target="_blank" rel="noreferrer">Create GitHub token</a>
					<a href="https://github.com/Eliahhango/Directory-Downloader" target="_blank" rel="noreferrer">Original project</a>
				</div>
			</footer>
		</div>
	);
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


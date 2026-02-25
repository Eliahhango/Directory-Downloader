# Directory Downloader

Download a GitHub directory as a zip archive.

## Features

- Download any GitHub folder as a zip
- Private repo support via GitHub token (stored locally)
- Theme selector and responsive UI
- Progress, activity log, and recent URL history
- Shareable links with `url` and `filename` query params

## Usage

1. Paste a GitHub directory URL, for example:
   `https://github.com/mrdoob/three.js/tree/dev/build`
2. Optional: set a custom filename.
3. Press `Download directory`.

You can also share a link that auto-starts the download:
`/?url=https://github.com/mrdoob/three.js/tree/dev/build&filename=three-js-build`

## Development

- Install: `npm install`
- Run dev server: `npm run watch:build`
- Type check: `npm run build:typescript`
- Tests: `npm run test:vitest`
- Lint: `npm run lint`

## Deploy to Vercel

This app is a static site built with Parcel. The repo includes `vercel.json`:

- Build command: `npm run build:bundle`
- Output directory: `public`

To deploy:

1. Push the repo to GitHub.
2. Import the project in Vercel.
3. Vercel will read `vercel.json` and deploy the static output.

## License

MIT# Directory-Downloader

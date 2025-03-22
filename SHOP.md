# Shop Plugin Development Guide

Welcome to this comprehensive guide on creating a Shop plugin for ShopRAG! In this tutorial, we’ll walk you through the process of building a fully-featured **GitHub Repository Shop** plugin step-by-step. By the end, you’ll have a production-ready Shop that integrates seamlessly with ShopRAG, complete with support for GitHub-specific features like repository URLs, branches, update intervals, and file filtering via include/ignore globs. More importantly, you’ll gain a deep understanding of **why** and **how** Shop plugins work within the ShopRAG ecosystem.

Let’s dive in!

---

## What is a Shop in ShopRAG?

A **Shop** in ShopRAG is a plugin responsible for fetching data from an external source and providing updates to ShopRAG’s unified dataset. These updates include **adding new files**, **updating existing files**, or **deleting files** that no longer exist in the source. Shops don’t return their entire dataset every time they’re run—only the *changes* since the last execution. This design ensures efficiency and scalability, especially when dealing with large data sources like GitHub repositories.

Our example Shop will connect to a GitHub repository, fetch its files, apply filters, and detect changes based on timestamps provided by ShopRAG. Let’s explore the requirements and then build it piece by piece.

---

## Requirements for Our GitHub Repo Shop

Our GitHub Repository Shop will support the following features:

- **Repository URL**: Specify the GitHub repo to fetch data from (e.g., `https://github.com/user/repo`).
- **Branch**: Target a specific branch (e.g., `main`).
- **Update Interval**: Define how often to check for updates (e.g., `1h` for hourly, `1w` for weekly). If the Shop was run within this interval, it skips updates.
- **Include Globs**: Only include files matching patterns like `**/*.md` or `**/*.txt`.
- **Ignore Globs**: Exclude files matching patterns like `node_modules/**`.
- **First Run Behavior**: Add all filtered files from the repo if it’s the Shop’s first execution.
- **Change Detection**: Only return files that have been added, updated, or deleted since the last run, using timestamps from ShopRAG.
- **Content Delivery**: Provide the string content for added or updated files.
- **Deletion Handling**: Mark files for deletion if they’re no longer in the repo.

---

## Understanding the Shop Interface

Every Shop plugin must implement the `Shop` interface from `@shoprag/core`. Here’s what it looks like:

```typescript
export interface Shop {
    requiredCredentials(): { [credentialName: string]: string };
    init(credentials: { [key: string]: string }, config: JsonObject): Promise<void>;
    update(
        lastUsed: number,
        existingFiles: { [fileId: string]: number }
    ): Promise<{ [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } }>;
}
```

### Method Breakdown

1. **`requiredCredentials()`**
   - **Purpose**: Declares the credentials the Shop needs (e.g., a GitHub token).
   - **Returns**: A dictionary where keys are credential names and values are instructions for obtaining them.
   - **Why**: ShopRAG prompts users for these credentials if they’re missing, ensuring secure and reusable access.

2. **`init(credentials, config)`**
   - **Purpose**: Initializes the Shop with credentials and configuration from `shoprag.json`.
   - **Parameters**:
     - `credentials`: User-provided secrets (e.g., `{ github_token: "your-token" }`).
     - `config`: Shop-specific settings as a `JsonObject` (e.g., `{ repoUrl: "https://github.com/user/repo", include: ["**/*.md"], ignore: ["node_modules/**"] }`).
   - **Why**: Sets up connections or state before fetching data, like authenticating with the GitHub API.

3. **`update(lastUsed, existingFiles)`**
   - **Purpose**: Detects and returns changes since the last run.
   - **Parameters**:
     - `lastUsed`: Timestamp (ms since epoch) when the Shop was last executed.
     - `existingFiles`: Dictionary of `fileId` to `lastUpdated` timestamp for files this Shop previously contributed.
   - **Returns**: A dictionary mapping `fileId` to an update object with `action` (`add`, `update`, `delete`) and optional `content`.
   - **Why**: Ensures ShopRAG only processes changes, not the entire dataset, reducing redundancy.

---

## Step-by-Step Development

Let’s build our GitHub Repo Shop, exploring each component and its rationale.

### Step 1: Project Setup

First, create a new Node.js project for your Shop plugin:

```bash
mkdir shoprag-shop-github-repo
cd shoprag-shop-github-repo
npm init -y
```

Install required dependencies:

- `@shoprag/core`: For the Shop interface.
- `@octokit/rest`: GitHub API client.
- `minimatch`: For glob pattern matching.

```bash
npm install @shoprag/core @octokit/rest minimatch
```

Also add `typescript` and `@types/node` for development:

```bash
npm install --save-dev typescript @types/node
```

Update `package.json` to make it a ShopRAG plugin:

```json
{
  "name": "@shoprag/shop-github-repo",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "type": "module",
  "scripts": {
    "build": "tsc"
  },
  "description": "A ShopRAG plugin for fetching files from a GitHub repository.",
  "keywords": ["shoprag", "shop", "github"],
  "author": "Your Name",
  "license": "MIT"
}
```

Create `tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "ES2020",
        "module": "ES2020",
        "moduleResolution": "node",
        "outDir": "./dist",
        "rootDir": "./src",
        "strict": false,
        "allowJs": true,
        "esModuleInterop": true,
        "forceConsistentCasingInFileNames": true,
        "declaration": true
    },
    "include": [
        "src"
    ]
}
```

Create `src/index.ts` as the entry point.

---

### Step 2: Defining Configuration

Our Shop will read its settings from `shoprag.json`. Here’s an example configuration using direct JSON arrays for `include` and `ignore`:

```json
{
  "from": "github-repo",
  "config": {
    "repoUrl": "https://github.com/user/repo",
    "branch": "main",
    "updateInterval": "1d",
    "include": ["**/*.md", "**/*.txt"],
    "ignore": ["node_modules/**", ".github/**"]
  }
}
```

- **Why direct JSON arrays?**: The updated ShopRAG core now supports complex JSON types in `config`, allowing us to use arrays directly for `include` and `ignore`. This makes the configuration more intuitive and eliminates the need to parse JSON strings.

---

### Step 3: Implementing `requiredCredentials`

Since we’re accessing GitHub, we need a personal access token. Define it like this:

```typescript
requiredCredentials(): { [credentialName: string]: string } {
    return {
        github_token: `To obtain a GitHub token:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token"
3. Select scopes (e.g., 'repo' for private repos)
4. Copy the token and paste it here.`
    };
}
```

- **Rationale**: ShopRAG uses this to prompt users and store the token in `~/.shoprag/creds.json`, making it reusable across projects.

---

### Step 4: Implementing `init`

The `init` method sets up the Shop with credentials and config:

```typescript
import { Shop } from '@shoprag/core';
import { Octokit } from '@octokit/rest';

export default class GitHubRepoShop implements Shop {
    private octokit: Octokit;
    private config: JsonObject;
    private updateIntervalMs: number;

    async init(credentials: { [key: string]: string }, config: JsonObject): Promise<void> {
        this.config = config;
        const token = credentials['github_token'];
        if (!token) {
            throw new Error('GitHub token is required.');
        }
        this.octokit = new Octokit({ auth: token });

        const interval = config['updateInterval'] || '1d';
        this.updateIntervalMs = this.parseInterval(interval as string);
    }

    private parseInterval(interval: string): number {
        const unit = interval.slice(-1);
        const value = parseInt(interval.slice(0, -1), 10);
        switch (unit) {
            case 'm': return value * 60 * 1000; // minutes
            case 'h': return value * 60 * 60 * 1000; // hours
            case 'd': return value * 24 * 60 * 60 * 1000; // days
            case 'w': return value * 7 * 24 * 60 * 60 * 1000; // weeks
            default: throw new Error(`Invalid interval unit: ${unit}`);
        }
    }
    // ... other methods to come
}
```

- **Why store config and credentials?**: We need them later for API calls and update logic.
- **Why parse the interval?**: Converting to milliseconds allows easy time comparisons in `update`.
- **Note**: We cast `interval` as a string since it’s still provided as a string value in this field, despite the `JsonObject` type.

---

### Step 5: Helper Functions

Before implementing `update`, let’s create utilities:

#### Extracting Repo Info

Parse the owner and repo from the URL:

```typescript
private getRepoInfo(): { owner: string; repo: string } {
    const url = this.config['repoUrl'] as string;
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
        throw new Error(`Invalid GitHub repo URL: ${url}`);
    }
    return { owner: match[1], repo: match[2] };
}
```

#### Fetching the Repository Tree

Get all files from the specified branch:

```typescript
private async getRepoTree(): Promise<any> {
    const { owner, repo } = this.getRepoInfo();
    const branch = this.config['branch'] as string || 'master';
    const response = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: 'true'
    });
    return response.data.tree;
}
```

#### Applying Include/Ignore Filters

Use `minimatch` to filter files, accessing `include` and `ignore` as arrays:

```typescript
import { minimatch } from 'minimatch';

private shouldInclude(path: string): boolean {
    const includePatterns = this.config['include'] ? this.config['include'] as string[] : ['**/*'];
    const ignorePatterns = this.config['ignore'] ? this.config['ignore'] as string[] : [];

    const isIncluded = includePatterns.some((pattern: string) => minimatch(path, pattern));
    const isIgnored = ignorePatterns.some((pattern: string) => minimatch(path, pattern));

    return isIncluded && !isIgnored;
}
```

- **Why filter locally?**: GitHub’s API doesn’t support glob filtering, so we fetch all files and apply patterns ourselves.

#### Fetching Current Files

Get the filtered file list with content:

```typescript
private async getCurrentFiles(): Promise<{ [path: string]: { fileId: string; content: string } }> {
    const tree = await this.getRepoTree();
    const files: { [path: string]: { fileId: string; content: string } } = {};

    for (const item of tree) {
        if (item.type === 'blob' && this.shouldInclude(item.path)) {
            const fileId = `github-repo-${this.getRepoInfo().owner}-${this.getRepoInfo().repo}-${item.path.replace(/\//g, '-')}`;
            const contentResponse = await this.octokit.git.getBlob({
                owner: this.getRepoInfo().owner,
                repo: this.getRepoInfo().repo,
                file_sha: item.sha
            });
            const content = Buffer.from(contentResponse.data.content, 'base64').toString('utf-8');
            files[item.path] = { fileId, content };
        }
    }
    return files;
}
```

- **Why this `fileId` format?**: It’s unique across repos and avoids path conflicts by replacing `/` with `-`.
- **Why fetch content?**: We need it for `add` and `update` actions.

#### Converting `fileId` Back to Path

For checking commit times:

```typescript
private fileIdToPath(fileId: string): string {
    const prefix = `github-repo-${this.getRepoInfo().owner}-${this.getRepoInfo().repo}-`;
    if (!fileId.startsWith(prefix)) {
        throw new Error(`Invalid fileId: ${fileId}`);
    }
    const pathWithDashes = fileId.slice(prefix.length);
    return pathWithDashes.replace(/-/g, '/');
}
```

#### Getting Last Commit Time

Check when a file was last modified:

```typescript
private async getLastCommitTimeForFile(path: string): Promise<number> {
    const { owner, repo } = this.getRepoInfo();
    const branch = this.config['branch'] as string || 'master';
    const response = await this.octokit.repos.listCommits({
        owner,
        repo,
        sha: branch,
        path: path,
        per_page: 1
    });
    if (response.data.length === 0) {
        return 0;
    }
    return new Date(response.data[0].commit.author.date).getTime();
}
```

- **Why limit to 1 commit?**: We only need the most recent change.

---

### Step 6: Implementing `update`

This is the heart of the Shop. Here’s how it works:

1. **Check Update Interval**: Skip if not enough time has passed since `lastUsed`.
2. **Fetch Current Files**: Get the repo’s current state.
3. **Detect Deletions**: Compare `existingFiles` with current files.
4. **Detect Additions and Updates**: Compare timestamps to find changes.
5. **Return Updates**: Provide the change set with content where needed.

```typescript
async update(
    lastUsed: number,
    existingFiles: { [fileId: string]: number }
): Promise<{ [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } }> {
    const now = Date.now();
    if (now - lastUsed < this.updateIntervalMs) {
        console.log(`Update interval not reached. Skipping update for ${this.config['repoUrl']}`);
        return {};
    }

    const currentFiles = await this.getCurrentFiles();
    const updates: { [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } } = {};

    // Map existing fileIds to paths
    const existingPaths: { [fileId: string]: string } = {};
    for (const fileId in existingFiles) {
        existingPaths[fileId] = this.fileIdToPath(fileId);
    }

    // Detect deletions
    for (const fileId in existingFiles) {
        const path = existingPaths[fileId];
        if (!(path in currentFiles)) {
            updates[fileId] = { action: 'delete' };
        }
    }

    // Detect additions and updates
    for (const path in currentFiles) {
        const { fileId, content } = currentFiles[path];
        if (!(fileId in existingFiles)) {
            updates[fileId] = { action: 'add', content };
        } else {
            const lastUpdated = existingFiles[fileId];
            const lastCommitTime = await this.getLastCommitTimeForFile(path);
            if (lastCommitTime > lastUpdated) {
                updates[fileId] = { action: 'update', content };
            }
        }
    }

    return updates;
}
```

#### Why This Logic?

- **Interval Check**: Prevents unnecessary API calls, respecting the user’s `updateInterval`.
- **First Run**: If `existingFiles` is empty, all current files are added—perfect for initial runs.
- **Change Detection**: Comparing commit times with `lastUpdated` ensures we only return modified files.
- **Deletions**: Files in `existingFiles` but missing from the repo are marked for removal.
- **Efficiency**: Only fetching content and commit times for filtered files minimizes API usage.

---

### Step 7: Full Code

Here’s the complete, production-ready `index.ts`:

```typescript
import { Shop } from '@shoprag/core';
import { Octokit } from '@octokit/rest';
import { minimatch, JsonObject } from 'minimatch';

export default class GitHubRepoShop implements Shop {
    private octokit: Octokit;
    private config: JsonObject;
    private updateIntervalMs: number;

    requiredCredentials(): { [credentialName: string]: string } {
        return {
            github_token: `To obtain a GitHub token:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token"
3. Select scopes (e.g., 'repo' for private repos)
4. Copy the token and paste it here.`
        };
    }

    async init(credentials: { [key: string]: string }, config: JsonObject): Promise<void> {
        this.config = config;
        const token = credentials['github_token'];
        if (!token) {
            throw new Error('GitHub token is required.');
        }
        this.octokit = new Octokit({ auth: token });

        const interval = config['updateInterval'] || '1d';
        this.updateIntervalMs = this.parseInterval(interval as string);
    }

    private parseInterval(interval: string): number {
        const unit = interval.slice(-1);
        const value = parseInt(interval.slice(0, -1), 10);
        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            case 'w': return value * 7 * 24 * 60 * 60 * 1000;
            default: throw new Error(`Invalid interval unit: ${unit}`);
        }
    }

    private getRepoInfo(): { owner: string; repo: string } {
        const url = this.config['repoUrl'] as string;
        const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) {
            throw new Error(`Invalid GitHub repo URL: ${url}`);
        }
        return { owner: match[1], repo: match[2] };
    }

    private async getRepoTree(): Promise<any> {
        const { owner, repo } = this.getRepoInfo();
        const branch = this.config['branch'] as string || 'master';
        const response = await this.octokit.git.getTree({
            owner,
            repo,
            tree_sha: branch,
            recursive: 'true'
        });
        return response.data.tree;
    }

    private shouldInclude(path: string): boolean {
        const includePatterns = this.config['include'] ? this.config['include'] as string[] : ['**/*'];
        const ignorePatterns = this.config['ignore'] ? this.config['ignore'] as string[] : [];
        const isIncluded = includePatterns.some((pattern: string) => minimatch(path, pattern));
        const isIgnored = ignorePatterns.some((pattern: string) => minimatch(path, pattern));
        return isIncluded && !isIgnored;
    }

    private async getCurrentFiles(): Promise<{ [path: string]: { fileId: string; content: string } }> {
        const tree = await this.getRepoTree();
        const files: { [path: string]: { fileId: string; content: string } } = {};
        for (const item of tree) {
            if (item.type === 'blob' && this.shouldInclude(item.path)) {
                const fileId = `github-repo-${this.getRepoInfo().owner}-${this.getRepoInfo().repo}-${item.path.replace(/\//g, '-')}`;
                const contentResponse = await this.octokit.git.getBlob({
                    owner: this.getRepoInfo().owner,
                    repo: this.getRepoInfo().repo,
                    file_sha: item.sha
                });
                const content = Buffer.from(contentResponse.data.content, 'base64').toString('utf-8');
                files[item.path] = { fileId, content };
            }
        }
        return files;
    }

    private fileIdToPath(fileId: string): string {
        const prefix = `github-repo-${this.getRepoInfo().owner}-${this.getRepoInfo().repo}-`;
        if (!fileId.startsWith(prefix)) {
            throw new Error(`Invalid fileId: ${fileId}`);
        }
        return fileId.slice(prefix.length).replace(/-/g, '/');
    }

    private async getLastCommitTimeForFile(path: string): Promise<number> {
        const { owner, repo } = this.getRepoInfo();
        const branch = this.config['branch'] as string || 'master';
        const response = await this.octokit.repos.listCommits({
            owner,
            repo,
            sha: branch,
            path: path,
            per_page: 1
        });
        if (response.data.length === 0) {
            return 0;
        }
        return new Date(response.data[0].commit.author.date).getTime();
    }

    async update(
        lastUsed: number,
        existingFiles: { [fileId: string]: number }
    ): Promise<{ [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } }> {
        const now = Date.now();
        if (now - lastUsed < this.updateIntervalMs) {
            console.log(`Update interval not reached. Skipping update for ${this.config['repoUrl']}`);
            return {};
        }

        const currentFiles = await this.getCurrentFiles();
        const updates: { [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } } = {};

        const existingPaths: { [fileId: string]: string } = {};
        for (const fileId in existingFiles) {
            existingPaths[fileId] = this.fileIdToPath(fileId);
        }

        for (const fileId in existingFiles) {
            const path = existingPaths[fileId];
            if (!(path in currentFiles)) {
                updates[fileId] = { action: 'delete' };
            }
        }

        for (const path in currentFiles) {
            const { fileId, content } = currentFiles[path];
            if (!(fileId in existingFiles)) {
                updates[fileId] = { action: 'add', content };
            } else {
                const lastUpdated = existingFiles[fileId];
                const lastCommitTime = await this.getLastCommitTimeForFile(path);
                if (lastCommitTime > lastUpdated) {
                    updates[fileId] = { action: 'update', content };
                }
            }
        }

        return updates;
    }
}
```

---

## Publishing Your Shop

1. **Compile TypeScript** (if distributing as JS):
   - Add `"tsc": "tsc"` to `scripts` in `package.json` and a `tsconfig.json`.
   - Run `npm run tsc`.
2. **Test Locally**: Use `npm link` and test with a ShopRAG project.
3. **Publish to npm**:
   ```bash
   npm publish --access public
   ```

Users can then install it with `npm install -g @shoprag/shop-github-repo`.

---

## Conclusion

You’ve now built a robust GitHub Repo Shop that:

- Configures flexibly with URLs, branches, intervals, and globs.
- Authenticates securely via GitHub tokens.
- Efficiently detects and delivers only changed files.
- Integrates seamlessly with ShopRAG’s pipeline.

This process has illuminated the **why** behind Shops: they’re designed to be lightweight, change-focused, and extensible, ensuring ShopRAG remains a powerful tool for data unification. Apply these principles to create Shops for any data source—happy coding!
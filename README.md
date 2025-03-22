<p align="center">
  <img src="shoprag.png" alt="ShopRAG" width="300"/>
</p>

# `@shoprag/core`

**ShopRAG** is a modular and extensible system designed to streamline data acquisition and management. It pulls data from diverse sources (called **Shops**), normalizes it, and maintains the resulting dataset in one or more downstream systems (called **RAGs**). At its heart, `@shoprag/core` provides the essential logic to orchestrate this process, offering a powerful CLI for managing configurations, credentials, and the data pipeline.

Whether you're aggregating content from GitHub repositories, YouTube channels, or custom sources, `@shoprag/core` unifies the process, making it easy to integrate with storage systems like local directories, S3 buckets, or even vector databases.

## Why?

Because Ty Everett got SICK AND TIRED of managing data pipelines and AI context across systems, normalizing it, keeping it updated all the time, and the world needed a better way.

## Key Features

- **Configuration Management**: Define projects with a `shoprag.json` file, specifying Shops, RAGs, and their configurations.
- **Credential Management**: Securely store and manage API keys and tokens in `~/.shoprag/creds.json`, reusable across projects.
- **Plugin System**: Dynamically load Shop and RAG plugins from npm, enabling a customizable data pipeline.
- **Data Pipeline**: Fetch updates from Shops and apply them to RAGs, with built-in tracking via `shoprag-lock.json`.
- **Interactive CLI**: Use an intuitive interface powered by Inquirer and Commander to create projects, configure settings, and run the pipeline.

## Installation

Install `@shoprag/core` globally using npm to access the `shoprag` CLI:

```bash
npm install -g @shoprag/core
```

## Awesome Examples

Check out [shoprag/awesome](https://github.com/shoprag/awesome) for links to all Shops, RAGs, and `shoprag.json` files from around the ecosystem!

## Usage

The `shoprag` CLI is your gateway to managing ShopRAG projects. Below are the primary commands:

### Creating a New Project

Start a new project in a directory without a `shoprag.json` file:

```bash
shoprag
```

Or explicitly trigger the creation wizard:

```bash
shoprag create
```

This prompts you to:
- Enter a project name.
- Initialize an empty `shoprag.json` file.
- Transition to the interactive config editor to add Shops and RAGs.

### Configuring a Project

Edit an existing `shoprag.json` interactively:

```bash
shoprag config
```

The config editor lets you:
- Modify the project name.
- Add, remove, or configure Shops and RAGs.
- Edit their respective `config` dictionaries (key-value pairs).

### Running the Data Pipeline

Execute the pipeline to fetch data from Shops and update RAGs:

```bash
shoprag
```

This:
- Checks for `shoprag.json` (prompts to create if missing).
- Ensures all required Shop and RAG plugins are installed.
- Prompts for missing credentials, saving them to `~/.shoprag/creds.json`.
- Initializes Shops and RAGs, gathers updates, applies them to RAGs, and updates `shoprag-lock.json`.

## Configuration

The `shoprag.json` file defines your project. It resides in the project’s working directory and follows this structure:

```json
{
  "Project_Name": "MyDataProject",
  "ShopRAG": "1.0",
  "Shops": [
    {
      "from": "github-repo",
      "config": {
        "repoUrl": "https://github.com/user/repo",
        "branch": "main"
      }
    },
    {
      "from": "youtube-channel",
      "config": {
        "channelId": "UC_x5XG1OV2P6uZZ5FSM9Ttw"
      }
    }
  ],
  "RAGs": [
    {
      "to": "dir",
      "config": {
        "outputDir": "./data"
      }
    }
  ]
}
```

### Fields Explained

- **`Project_Name`**: A human-readable name for your project.
- **`ShopRAG`**: The configuration version (currently `"1.0"`).
- **`Shops`**: An array of Shop definitions:
  - **`from`**: The Shop plugin name (e.g., `"github-repo"` uses `@shoprag/shop-github-repo`).
  - **`config`**: A dictionary of plugin-specific settings.
- **`RAGs`**: An array of RAG definitions:
  - **`to`**: The RAG plugin name (e.g., `"dir"` uses `@shoprag/rag-dir`).
  - **`config`**: A dictionary of plugin-specific settings.

Each Shop and RAG plugin defines its own `config` requirements—check their documentation for details.

## Credentials

Shops and RAGs often require credentials (e.g., API keys, tokens) to function. These are stored in `~/.shoprag/creds.json`, a global file accessible across all ShopRAG projects.

When running `shoprag`, if a required credential is missing:
1. The CLI identifies it via the plugin’s `requiredCredentials()` method.
2. It displays instructions (provided by the plugin) on how to obtain it.
3. You input the value, which is then saved for future use.

### Example Prompt

```
🔑 The plugin "github-repo" requires the following credentials:

Credential: github_token
Instructions:
To obtain a GitHub token:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token"
3. Select scopes (e.g., repo)
4. Copy the token and paste it here.

Enter value for "github_token":
```

Once entered, `~/.shoprag/creds.json` updates to include:

```json
{
  "github_token": "your-token-here"
}
```

## The Data Pipeline

The core workflow of `@shoprag/core` involves:
1. **Loading Config**: Reads `shoprag.json` and `shoprag-lock.json`.
2. **Plugin Management**: Installs and imports Shop/RAG plugins dynamically.
3. **Credential Check**: Ensures all required credentials are available.
4. **Shop Updates**: Queries each Shop for updates (add, update, delete) based on the lock file’s metadata.
5. **RAG Updates**: Applies the aggregated updates to all RAGs.
6. **Lock File Update**: Records Shop usage timestamps and file origins.

### Lock File (`shoprag-lock.json`)

This file tracks:
- **Shop Last Used**: When each Shop was last run (e.g., `"github-repo[0]": 1698765432100`).
- **File Origins**: Which Shop contributed each file and its last update time.

Example:

```json
{
  "shopLastUsed": {
    "github-repo[0]": 1698765432100
  },
  "fileOrigins": {
    "github-repo-user1-repo1-file1": {
      "shopIdentifier": "github-repo[0]",
      "lastUpdated": 1698765432100
    }
  }
}
```

## Extending ShopRAG

ShopRAG’s modularity shines through its plugin system. You can create custom Shops and RAGs to suit your needs.

### Writing a Shop

Implement the `Shop` interface:

```typescript
export interface Shop {
  requiredCredentials(): { [credentialName: string]: string };
  init(credentials: { [key: string]: string }, config: { [key: string]: any }): Promise<void>;
  update(
    lastUsed: number,
    existingFiles: { [fileId: string]: number }
  ): Promise<{ [fileId: string]: { action: 'add' | 'update' | 'delete'; content?: string } }>;
}
```

- Prefix file IDs with the lowercase Shop name (e.g., `github-repo-user1-repo1-file1`) to avoid conflicts.
- Return updates based on `lastUsed` and `existingFiles`.

### Writing a RAG

Implement the `RAG` interface:

```typescript
export interface RAG {
  requiredCredentials(): { [credentialName: string]: string };
  init(credentials: { [key: string]: string }, config: { [key: string]: any }): Promise<void>;
  addFile(fileId: string, content: string): Promise<void>;
  updateFile(fileId: string, content: string): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
  finalize(): Promise<void>;
  deleteAllFiles(): Promise<void>;
}
```

- Manage file storage as needed (e.g., local files, cloud storage).
- Use `finalize()` to commit changes.

For detailed plugin development guides, see the [Shop](./SHOP.md) and [RAG](./RAG.md) plugin docs.

## Examples

### Example 1: Simple GitHub to Directory

1. Create a project:

```bash
shoprag create
```

- Name: `"GitHubSync"`.

2. Add a Shop (`github-repo`):
   - `from`: `"github-repo"`
   - `config`: `{ "repoUrl": "https://github.com/user/repo", "branch": "main" }`

3. Add a RAG (`dir`):
   - `to`: `"dir"`
   - `config`: `{ "outputDir": "./data" }`

4. Run it:

```bash
shoprag
```

- Provide a `github_token` if prompted.
- Data from the repo is normalized and stored as `.txt` files in `./data`.

### Example 2: Multi-Source Aggregation

Configure `shoprag.json`:

```json
{
  "Project_Name": "ContentHub",
  "ShopRAG": "1.0",
  "Shops": [
    {
      "from": "github-repo",
      "config": { "repoUrl": "https://github.com/user/repo", "branch": "main" }
    },
    {
      "from": "youtube-channel",
      "config": { "channelId": "UC_x5XG1OV2P6uZZ5FSM9Ttw" }
    }
  ],
  "RAGs": [
    {
      "to": "dir",
      "config": { "outputDir": "./local-data" }
    },
    {
      "to": "s3",
      "config": { "bucket": "my-bucket" }
    }
  ]
}
```

Run `shoprag` to:
- Fetch from GitHub and YouTube.
- Store in both a local directory and an S3 bucket.

## Contributing

We welcome contributions! Please submit issues, PRs, or plugin ideas.

## License

This project is licensed under the MIT License.

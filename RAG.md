# RAG Plugin Development Guide

Welcome to this comprehensive guide on creating a **RAG plugin** for ShopRAG! In this tutorial, we'll walk you through the process of building a fully-featured `@shoprag/rag-dir` plugin step-by-step. By the end, you'll have a production-ready RAG that stores data as `.txt` files in a specified local directory, and you'll deeply understand the "how" and "why" behind RAG plugins in the ShopRAG ecosystem.

---

## What is a RAG Plugin?

In ShopRAG, a **RAG** is a plugin responsible for **storing and managing the normalized data** fetched and processed by **Shops**. While Shops handle data retrieval from external sources (e.g., GitHub, YouTube), RAGs determine *where* and *how* that data is persisted—be it a local directory, an S3 bucket, or a vector database.

The `@shoprag/rag-dir` plugin we'll build stores this data as plain text (`.txt`) files in a user-specified output directory. This simplicity makes it an excellent starting point to grasp the RAG plugin architecture.

### Why RAG Plugins Matter

RAGs are the downstream backbone of ShopRAG’s data pipeline:
- **Flexibility**: They allow you to choose your storage solution.
- **Consistency**: They apply updates (add, update, delete) uniformly across all configured RAGs.
- **Extensibility**: You can write custom RAGs for unique storage needs.

Understanding RAGs means mastering how ShopRAG persists and synchronizes data—a critical piece of its modular design.

---

## The RAG Interface

Every RAG plugin must implement the `RAG` interface defined in `@shoprag/core`. Here’s the TypeScript definition with explanations:

```typescript
export interface RAG {
    requiredCredentials(): { [credentialName: string]: string };
    init(credentials: { [key: string]: string }, config: JsonObject): Promise<void>;
    addFile(fileId: string, content: string): Promise<void>;
    updateFile(fileId: string, content: string): Promise<void>;
    deleteFile(fileId: string): Promise<void>;
    finalize(): Promise<void>;
    deleteAllFiles(): Promise<void>;
}
```

### Method Breakdown

1. **`requiredCredentials(): { [credentialName: string]: string }`**
   - **Purpose**: Specifies any credentials (e.g., API keys) the RAG needs.
   - **Returns**: A dictionary where keys are credential names, and values are instructions for obtaining them.
   - **Why**: Ensures users provide necessary secrets during setup, stored in `~/.shoprag/creds.json`.

2. **`init(credentials: { [key: string]: string }, config: JsonObject): Promise<void>`**
   - **Purpose**: Initializes the RAG with credentials and configuration from `shoprag.json`.
   - **Parameters**:
     - `credentials`: User-provided secrets.
     - `config`: Plugin-specific settings (e.g., output directory).
   - **Why**: Sets up the RAG for operation, like creating directories or opening connections.

3. **`addFile(fileId: string, content: string): Promise<void>`**
   - **Purpose**: Adds a new file to the RAG.
   - **Parameters**:
     - `fileId`: Unique identifier for the file (e.g., `github-repo-file1`).
     - `content`: The file’s content as a string.
   - **Why**: Handles new data from Shops.

4. **`updateFile(fileId: string, content: string): Promise<void>`**
   - **Purpose**: Updates an existing file’s content.
   - **Why**: Reflects changes in source data.

5. **`deleteFile(fileId: string): Promise<void>`**
   - **Purpose**: Removes a file from the RAG.
   - **Why**: Cleans up obsolete data.

6. **`finalize(): Promise<void>`**
   - **Purpose**: Commits or finalizes changes after all operations.
   - **Why**: Ensures data consistency (e.g., flushing buffers in complex RAGs).

7. **`deleteAllFiles(): Promise<void>`**
   - **Purpose**: Deletes all files managed by the RAG.
   - **Why**: Provides a reset option, though optional in practice.

All methods return `Promise<void>` because ShopRAG operates asynchronously, ensuring non-blocking execution.

---

## Designing `@shoprag/rag-dir`

Our goal is to create `@shoprag/rag-dir`, a RAG plugin that:
- **Stores files** as `.txt` in a local directory.
- **Uses `outputDir`** from the `config` to determine the storage location.

### Requirements
- No credentials needed (local file system access only).
- Files named using `fileId` with a `.txt` extension.
- Support for adding, updating, deleting, and resetting files.

Let’s implement this step-by-step.

---

## Step 1: Set Up the Project

Since ShopRAG uses TypeScript, we’ll create a TypeScript project.

1. **Create the Directory and Initialize**
   ```bash
   mkdir shoprag-rag-dir
   cd shoprag-rag-dir
   npm init -y
   ```

2. **Install Dependencies**
   We’ll use Node.js built-in `fs` and `path` modules, but we need TypeScript and type definitions. We also need `@shoprag/core` for the `RAG` interface:
   ```bash
   npm install typescript @types/node --save-dev
   npm install @shoprag/core
   ```

   Now let's create `tsconfig.json`:

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

3. **Update `package.json`**
   Set the package name and main entry point. Also make sure `type` is set to `module`:
   ```json
   {
     "name": "@shoprag/rag-dir",
     "version": "1.0.0",
     "description": "ShopRAG RAG plugin for storing files in a local directory",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "type": "module",
     "scripts": {
       "build": "tsc"
     },
     "keywords": ["shoprag", "rag", "plugin"],
     "author": "Your Name",
     "license": "MIT",
     "devDependencies": {
       "typescript": "^4.0.0",
       "@types/node": "^14.0.0"
     }
   }
   ```

---

## Step 2: Implement the RAG Interface

Create `index.ts` in the project root and start coding.

### Initial Structure

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { RAG } from '@shoprag/core';

export class DirRAG implements RAG {
    private outputDir: string;

    // Methods will go here
}
```

- **`outputDir`**: A private property to store the resolved directory path, set during `init`.

### 2.1: `requiredCredentials`

Since `@shoprag/rag-dir` only writes to the local file system, it doesn’t need credentials.

```typescript
requiredCredentials(): { [credentialName: string]: string } {
    return {};
}
```

- **Why**: An empty object signals to ShopRAG that no user input is required, simplifying setup.

### 2.2: `init`

The `init` method sets up the output directory.

```typescript
async init(credentials: { [key: string]: string }, config: JsonObject): Promise<void> {
    if (!config['outputDir']) {
        throw new Error('outputDir must be specified in the config');
    }
    this.outputDir = path.resolve(process.cwd(), config['outputDir'] as string);
    if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
    }
}
```

- **How**:
  - Checks for `outputDir` in `config` (from `shoprag.json`’s RAG `config` field).
  - Resolves the path relative to the current working directory using `path.resolve`.
  - Creates the directory if it doesn’t exist with `fs.mkdirSync` (`recursive: true` ensures parent directories are created).
- **Why**:
  - Ensures the RAG has a valid location to store files.
  - Uses synchronous `mkdirSync` for simplicity since `init` is a one-time setup (async `fs.promises.mkdir` is an alternative).

### 2.3: Helper Method for File Paths

Since multiple methods need to construct file paths, let’s add a helper:

```typescript
private getSafeFilePath(fileId: string): string {
    const safeFileId = fileId.replace(/[\/\\]/g, '_');
    return path.join(this.outputDir, `${safeFileId}.txt`);
}
```

- **How**:
  - Replaces slashes (`/` or `\`) in `fileId` with underscores to prevent subdirectory creation.
  - Joins `outputDir` with the sanitized `fileId` and adds `.txt`.
- **Why**:
  - `fileId`s (e.g., `github-repo/path/to/file`) might contain unsafe characters.
  - Ensures consistent, flat file naming.

### 2.4: `addFile`

Add a new file to the directory.

```typescript
async addFile(fileId: string, content: string): Promise<void> {
    const filePath = this.getSafeFilePath(fileId);
    await fs.promises.writeFile(filePath, content, 'utf-8');
}
```

- **How**: Writes `content` to a `.txt` file at the computed path using async `fs.promises.writeFile`.
- **Why**: Provides non-blocking I/O, aligning with ShopRAG’s async design.

### 2.5: `updateFile`

Update an existing file.

```typescript
async updateFile(fileId: string, content: string): Promise<void> {
    await this.addFile(fileId, content);
}
```

- **How**: Reuses `addFile` since overwriting a file serves the same purpose.
- **Why**: Simplifies logic—`writeFile` overwrites by default, and ShopRAG tracks file existence.

### 2.6: `deleteFile`

Remove a file if it exists.

```typescript
async deleteFile(fileId: string): Promise<void> {
    const filePath = this.getSafeFilePath(fileId);
    if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
    }
}
```

- **How**:
  - Checks existence with `fs.existsSync`.
  - Deletes with `fs.promises.unlink` if present.
- **Why**: Avoids errors if the file is already gone, ensuring idempotency.

### 2.7: `finalize`

Commit changes (not needed here).

```typescript
async finalize(): Promise<void> {
    // No-op for this RAG
}
```

- **Why**: Local file writes are atomic; no batching or connections to finalize.

### 2.8: `deleteAllFiles`

Reset the RAG by deleting all `.txt` files.

```typescript
async deleteAllFiles(): Promise<void> {
    const files = await fs.promises.readdir(this.outputDir);
    for (const file of files) {
        if (file.endsWith('.txt')) {
            await fs.promises.unlink(path.join(this.outputDir, file));
        }
    }
}
```

- **How**: Reads the directory and deletes each `.txt` file.
- **Why**: Provides a clean slate, useful for testing or full resets.

---

## Step 3: Enhance with Error Handling

Robust plugins handle errors gracefully.

### Updated Methods

- **`addFile`**:
```typescript
async addFile(fileId: string, content: string): Promise<void> {
    const filePath = this.getSafeFilePath(fileId);
    try {
        await fs.promises.writeFile(filePath, content, 'utf-8');
    } catch (err) {
        throw new Error(`Failed to add file ${fileId}: ${err.message}`);
    }
}
```

- **`deleteFile`**:
```typescript
async deleteFile(fileId: string): Promise<void> {
    const filePath = this.getSafeFilePath(fileId);
    if (fs.existsSync(filePath)) {
        try {
            await fs.promises.unlink(filePath);
        } catch (err) {
            throw new Error(`Failed to delete file ${fileId}: ${err.message}`);
        }
    }
}
```

- **`deleteAllFiles`**:
```typescript
async deleteAllFiles(): Promise<void> {
    try {
        const files = await fs.promises.readdir(this.outputDir);
        for (const file of files) {
            if (file.endsWith('.txt')) {
                await fs.promises.unlink(path.join(this.outputDir, file));
            }
        }
    } catch (err) {
        throw new Error(`Failed to delete all files: ${err.message}`);
    }
}
```

- **Why**: Adds context to errors (e.g., permission issues), aiding debugging.

---

## Step 4: Test the Plugin

1. **Compile**:
   ```bash
   npm run build
   ```

2. **Create a Test Project**:
   - Run `shoprag create`, name it "TestDir".
   - Add a Shop (e.g., `github-repo`) and configure it.
   - Add a RAG: `to: "dir"`, `config: { "outputDir": "./data" }`.

3. **Run**:
   ```bash
   shoprag
   ```
   - Check `./data` for `.txt` files after providing credentials.

4. **Verify**: Update/delete operations by modifying the Shop source and rerunning.

---

## Step 5: Publish to npm

1. **Login to npm**:
   ```bash
   npm login
   ```

2. **Publish**:
   ```bash
   npm publish --access public
   ```

- **Why**: Makes `@shoprag/rag-dir` available globally for ShopRAG users.

---

## How It Fits in ShopRAG

- **Configuration**: Users specify `outputDir` in `shoprag.json` under `RAGs`.
- **Pipeline**: Shops generate updates, and `@shoprag/rag-dir` applies them as file operations.
- **Scalability**: Simple now, but could extend to support subdirectories or different formats.

---

## Final Code: `@shoprag/rag-dir`

Here’s the complete, production-ready implementation:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { RAG, JsonObject } from '@shoprag/core';

export default class DirRAG implements RAG {
    private outputDir: string;

    requiredCredentials(): { [credentialName: string]: string } {
        return {};
    }

    async init(credentials: { [key: string]: string }, config: JsonObject): Promise<void> {
        if (!config['outputDir']) {
            throw new Error('outputDir must be specified in the config');
        }
        this.outputDir = path.resolve(process.cwd(), config['outputDir'] as string);
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    private getSafeFilePath(fileId: string): string {
        const safeFileId = fileId.replace(/[\/\\]/g, '_');
        return path.join(this.outputDir, `${safeFileId}.txt`);
    }

    async addFile(fileId: string, content: string): Promise<void> {
        const filePath = this.getSafeFilePath(fileId);
        try {
            await fs.promises.writeFile(filePath, content, 'utf-8');
        } catch (err) {
            throw new Error(`Failed to add file ${fileId}: ${err.message}`);
        }
    }

    async updateFile(fileId: string, content: string): Promise<void> {
        await this.addFile(fileId, content);
    }

    async deleteFile(fileId: string): Promise<void> {
        const filePath = this.getSafeFilePath(fileId);
        if (fs.existsSync(filePath)) {
            try {
                await fs.promises.unlink(filePath);
            } catch (err) {
                throw new Error(`Failed to delete file ${fileId}: ${err.message}`);
            }
        }
    }

    async finalize(): Promise<void> {
        // No-op for this RAG
    }

    async deleteAllFiles(): Promise<void> {
        try {
            const files = await fs.promises.readdir(this.outputDir);
            for (const file of files) {
                if (file.endsWith('.txt')) {
                    await fs.promises.unlink(path.join(this.outputDir, file));
                }
            }
        } catch (err) {
            throw new Error(`Failed to delete all files: ${err.message}`);
        }
    }
}
```

---

## Conclusion

You’ve now built `@shoprag/rag-dir`, a RAG plugin that:
- Stores Shop data as `.txt` files in a configurable directory.
- Handles all required operations asynchronously.
- Includes error handling for robustness.

This tutorial has equipped you with the knowledge to create and extend RAG plugins, deepening your understanding of ShopRAG’s extensible architecture. Happy coding!

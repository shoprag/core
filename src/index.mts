#!/usr/bin/env node

/**
 * ShopRAG Core
 *
 * A TypeScript-based CLI utility that handles:
 *  - Reading and writing project-level configurations (shoprag.json)
 *  - Managing user credentials (stored in ~/.shoprag/creds.json)
 *  - Dynamically installing and loading "Shop" and "RAG" plugins
 *  - Interacting with Shops to fetch new or updated data
 *  - Applying these file-level changes to all configured RAGs
 *  - Providing an interactive config editor (via Inquirer)
 *  - Providing a create flow for new projects (shoprag.json)
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

/** 
 * Interface describing the shape of the Shop plugin.
 *
 * A "Shop" is responsible for retrieving data from an external source
 * and producing updates (add, update, delete) for ShopRAG's unified data set.
 */
export interface Shop {
    /**
     * Return the credentials this Shop requires. The returned object should
     * have keys that are credential names, and values that are multi-line
     * instructions telling the user how to obtain those credentials.
     */
    requiredCredentials(): { [credentialName: string]: string };

    /**
     * Initialize the Shop, providing all required credentials and
     * the config object (loaded from shoprag.json).
     *
     * @param credentials - The user-supplied credentials required by this Shop
     * @param config - The shop-specific config from shoprag.json
     */
    init(credentials: { [credentialName: string]: string }, config: JsonObject): Promise<void>;

    /**
     * Generate a dictionary of file-level updates (including adds, updates, or deletes)
     * based on the last time this Shop was used and the existing known files from this Shop.
     *
     * @param lastUsed - The timestamp (ms since epoch) when this Shop was last run
     * @param existingFiles - A dictionary mapping fileId -> lastUpdatedTimestamp.
     *                        This dictionary only includes files that were contributed
     *                        by this Shop.
     * @returns an object whose keys are fileIds and whose values describe
     *          the changes to be made. For example:
     *            {
     *              "someShop-fileA": {
     *                action: "update",
     *                content: "Hello, updated world!"
     *              },
     *              "someShop-fileB": {
     *                action: "delete"
     *              }
     *            }
     */
    update(
        lastUsed: number,
        existingFiles: { [fileId: string]: number }
    ): Promise<{ [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } }>;
}

/** 
 * Interface describing the shape of the RAG plugin.
 *
 * A "RAG" is responsible for storing the normalized data files downstream
 * in whatever format it wishes (files in a folder, a vector DB, S3 bucket, etc.).
 */
export interface RAG {
    /**
     * Return the credentials this RAG requires. The returned object should
     * have keys that are credential names, and values that are multi-line
     * instructions telling the user how to obtain those credentials.
     */
    requiredCredentials(): { [credentialName: string]: string };

    /**
     * Initialize the RAG, providing all required credentials and
     * the config object (loaded from shoprag.json). This also "opens"
     * a new editing session in case the RAG needs to queue changes
     * before finalizing them.
     *
     * @param credentials - The user-supplied credentials required by this RAG
     * @param config - The RAG-specific config from shoprag.json
     */
    init(credentials: { [credentialName: string]: string }, config: JsonObject): Promise<void>;

    /**
     * Add a new file with the given fileId and content to the RAG.
     *
     * @param fileId
     * @param content
     */
    addFile(fileId: string, content: string): Promise<void>;

    /**
     * Update an existing file with the given fileId and new content.
     *
     * @param fileId
     * @param content
     */
    updateFile(fileId: string, content: string): Promise<void>;

    /**
     * Delete a file with the given fileId from the RAG.
     *
     * @param fileId
     */
    deleteFile(fileId: string): Promise<void>;

    /**
     * Called after all adds/updates/deletes are completed to finalize
     * or "save" changes in the RAG.
     */
    finalize(): Promise<void>;

    /**
     * Delete all files from this RAG (optional usage in general, but
     * supported by the interface).
     */
    deleteAllFiles(): Promise<void>;
}

/**
 * Types for JSON values to support complex config structures
 */
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject {
    [key: string]: JsonValue;
}
interface JsonArray extends Array<JsonValue> { }

/**
 * The shape of the shoprag.json file that defines a "Project".
 */
interface ShopragJson {
    Project_Name: string;
    ShopRAG: string;
    Shops: Array<{
        from: string; // plugin name, e.g. "github-repo"
        config: JsonObject;
    }>;
    RAGs: Array<{
        to: string; // plugin name, e.g. "dir"
        config: JsonObject;
    }>;
}

/**
 * The shape of the shoprag-lock.json file (automatically managed by ShopRAG).
 */
interface ShopragLockJson {
    // Timestamps for each Shop, keyed by the "from" plugin + unique index in the array.
    // e.g. "youtube-channel[0]" => 123456789 (the ms timestamp when it was last used).
    shopLastUsed: {
        [shopUniqueIdentifier: string]: number;
    };
    // fileOrigins track the shop that contributed a given file, plus
    // the last updated timestamp for that file.
    // e.g. "youtube-channel[0]-myvideo001" => 1679353123000
    fileOrigins: {
        [fileId: string]: {
            shopIdentifier: string;
            lastUpdated: number;
        };
    };
    // Permissions for unofficial plugins, mapping plugin names to allowed credentials
    pluginPermissions: {
        [pluginName: string]: string[];
    };
}

/**
 * The shape of the user credentials file (creds.json in ~/.shoprag).
 * Keys are credential names, values are the actual secrets/tokens.
 */
interface CredentialsJson {
    [credentialName: string]: string;
}

/**
 * Utility function to get the path to the global user credentials file (~/.shoprag/creds.json).
 */
function getCredentialsFilePath(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
    const shopragDir = path.join(homeDir, '.shoprag');
    if (!fs.existsSync(shopragDir)) {
        fs.mkdirSync(shopragDir, { recursive: true });
    }
    return path.join(shopragDir, 'creds.json');
}

/**
 * Utility to load existing credentials or create an empty file if none exists.
 */
function loadOrInitializeCredentials(): CredentialsJson {
    const credsPath = getCredentialsFilePath();
    if (!fs.existsSync(credsPath)) {
        fs.writeFileSync(credsPath, JSON.stringify({}, null, 2), 'utf-8');
    }
    const contents = fs.readFileSync(credsPath, 'utf-8');
    return JSON.parse(contents) as CredentialsJson;
}

/**
 * Update the credentials file with new or updated credentials.
 */
function saveCredentials(newCredentials: CredentialsJson): void {
    const credsPath = getCredentialsFilePath();
    fs.writeFileSync(credsPath, JSON.stringify(newCredentials, null, 2), 'utf-8');
}

/**
 * Load the shoprag.json in the current directory, or return null if none found.
 */
function loadShopragJson(): ShopragJson | null {
    const shopragPath = path.join(process.cwd(), 'shoprag.json');
    if (!fs.existsSync(shopragPath)) {
        return null;
    }
    const data = fs.readFileSync(shopragPath, 'utf-8');
    return JSON.parse(data) as ShopragJson;
}

/**
 * Save the given ShopragJson structure to shoprag.json in the current directory.
 */
function saveShopragJson(shopragData: ShopragJson): void {
    const shopragPath = path.join(process.cwd(), 'shoprag.json');
    fs.writeFileSync(shopragPath, JSON.stringify(shopragData, null, 2), 'utf-8');
}

/**
 * Load the shoprag-lock.json, or return a default structure if not present.
 */
function loadOrInitializeLockJson(): ShopragLockJson {
    const lockPath = path.join(process.cwd(), 'shoprag-lock.json');
    if (!fs.existsSync(lockPath)) {
        return {
            shopLastUsed: {},
            fileOrigins: {},
            pluginPermissions: {}
        };
    }
    const data = fs.readFileSync(lockPath, 'utf-8');
    const lockData = JSON.parse(data) as ShopragLockJson;
    if (!lockData.pluginPermissions) {
        lockData.pluginPermissions = {};
    }
    return lockData;
}

/**
 * Write out an updated shoprag-lock.json file.
 */
function saveLockJson(lockData: ShopragLockJson): void {
    const lockPath = path.join(process.cwd(), 'shoprag-lock.json');
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2), 'utf-8');
}

/**
 * Dynamically install a plugin from NPM (global install).
 * This function uses "npm install -g" under the hood.
 */
function installPluginGlobally(pluginName: string) {
    console.log(`\n🔨 Installing plugin "${pluginName}" globally via npm...`);
    const result = spawnSync('npm', ['install', '-g', pluginName], { stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`Failed to install plugin "${pluginName}".`);
    }
    console.log(`✅ Successfully installed ${pluginName}\n`);
}

/**
 * Try importing a plugin. If it doesn't exist, attempt to install it globally.
 * Then import it again. If it still fails, throw an error.
 */
async function importOrInstallPlugin(pluginName: string): Promise<any> {
    try {
        return await import(pluginName);
    } catch (e) {
        console.log(`Plugin "${pluginName}" not found. Attempting to install...`);
        installPluginGlobally(pluginName);
        try {
            return await import(pluginName);
        } catch (err) {
            throw new Error(
                `Could not load plugin "${pluginName}" after installing. ` +
                `Make sure it is a valid package. Error: ${err}`
            );
        }
    }
}

/**
 * Ensure that the user has provided the needed credentials for a plugin.
 * If they are missing any, prompt them to input the values. Then store them
 * in the global credentials file for future usage.
 *
 * @param neededCredentials - dictionary of credentialName -> instructions
 * @param existingCreds - the current loaded credentials
 */
async function promptForMissingCredentials(
    pluginName: string,
    neededCredentials: { [credName: string]: string },
    existingCreds: CredentialsJson
): Promise<void> {
    const missingCreds: { name: string; instructions: string }[] = [];
    for (const credName of Object.keys(neededCredentials)) {
        if (!existingCreds[credName]) {
            missingCreds.push({ name: credName, instructions: neededCredentials[credName] });
        }
    }

    if (missingCreds.length === 0) {
        return;
    }

    console.log(`\n🔑 The plugin "${pluginName}" requires the following credentials:`);

    for (const mc of missingCreds) {
        console.log(`\nCredential: ${mc.name}\nInstructions:\n${mc.instructions}\n`);
    }

    // Prompt user for each missing credential
    const answers: any = await inquirer.prompt(missingCreds.map(mc => ({
        type: 'input',
        name: mc.name,
        message: `Enter value for "${mc.name}":`
    })));

    // Save them to existingCreds
    for (const credName of Object.keys(answers)) {
        existingCreds[credName] = answers[credName];
    }
    saveCredentials(existingCreds);
    console.log(`\n✅ Credentials saved successfully!\n`);
}

/**
 * Get a unique shop identifier based on the index in the array and the plugin name.
 * E.g. if a shop definition is "from: youtube-channel" and it's the second item in the
 * Shops array, we return "youtube-channel[1]" for identification in the lock file.
 */
function getShopIdentifier(shopDef: { from: string }, index: number): string {
    return `${shopDef.from}[${index}]`;
}

/**
 * Utility function to set a value in an object by path, supporting nested objects and arrays
 */
function setByPath(obj: any, path: string, value: any) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        let part = parts[i];
        if (part.endsWith(']')) {
            const match = part.match(/(.+)\[(\d+)\]/);
            if (match) {
                const key = match[1];
                const index = parseInt(match[2], 10);
                if (!current[key]) {
                    current[key] = [];
                }
                while (current[key].length <= index) {
                    current[key].push({});
                }
                current = current[key][index];
            } else {
                throw new Error(`Invalid path: ${path}`);
            }
        } else {
            if (!current[part] || typeof current[part] !== 'object') {
                current[part] = {};
            }
            current = current[part];
        }
    }
    let lastPart = parts[parts.length - 1];
    if (lastPart.endsWith(']')) {
        const match = lastPart.match(/(.+)\[(\d+)\]/);
        if (match) {
            const key = match[1];
            const index = parseInt(match[2], 10);
            if (!current[key]) {
                current[key] = [];
            }
            while (current[key].length <= index) {
                current[key].push(null);
            }
            current[key][index] = value;
        } else {
            throw new Error(`Invalid path: ${path}`);
        }
    } else {
        current[lastPart] = value;
    }
}

/**
 * Utility function to delete a value from an object by path, supporting nested objects and arrays
 */
function deleteByPath(obj: any, path: string) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        let part = parts[i];
        if (part.endsWith(']')) {
            const match = part.match(/(.+)\[(\d+)\]/);
            if (match) {
                const key = match[1];
                const index = parseInt(match[2], 10);
                if (!current[key] || !Array.isArray(current[key]) || index >= current[key].length) {
                    return; // Path doesn't exist
                }
                current = current[key][index];
            } else {
                return; // Invalid path
            }
        } else {
            if (!current[part] || typeof current[part] !== 'object') {
                return; // Path doesn't exist
            }
            current = current[part];
        }
    }
    let lastPart = parts[parts.length - 1];
    if (lastPart.endsWith(']')) {
        const match = lastPart.match(/(.+)\[(\d+)\]/);
        if (match) {
            const key = match[1];
            const index = parseInt(match[2], 10);
            if (current[key] && Array.isArray(current[key]) && index < current[key].length) {
                current[key].splice(index, 1);
            }
        }
    } else {
        delete current[lastPart];
    }
}

/**
 * Utility function to flatten a config object into a list of paths and values for display
 */
function flattenConfig(obj: any, prefix = ''): string[] {
    let result: string[] = [];
    if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
            const path = `${prefix}[${index}]`;
            if (typeof item === 'object' && item !== null) {
                result = result.concat(flattenConfig(item, path));
            } else {
                result.push(`${path}: ${JSON.stringify(item)}`);
            }
        });
    } else if (typeof obj === 'object' && obj !== null) {
        for (const key in obj) {
            const value = obj[key];
            const path = prefix ? `${prefix}.${key}` : key;
            if (typeof value === 'object' && value !== null) {
                result = result.concat(flattenConfig(value, path));
            } else {
                result.push(`${path}: ${JSON.stringify(value)}`);
            }
        }
    }
    return result;
}

/**
 * Commander-based CLI program definition
 */
const program = new Command();

program
    .name('shoprag')
    .description('ShopRAG: A command-line utility to unify data from multiple Shops and store into multiple RAGs.')
    .version('1.0.0');

async function createShopragJson() {
    const { projectName } = await inquirer.prompt([
        {
            type: 'input',
            name: 'projectName',
            message: 'Enter a name for this project:'
        }
    ]);

    const newData: ShopragJson = {
        Project_Name: projectName,
        ShopRAG: '1.0',
        Shops: [],
        RAGs: []
    };

    saveShopragJson(newData);
    console.log(`\n✅ Created new shoprag.json with project name: ${projectName}\n`);
}

/**
 * Subcommand: shoprag create
 *
 * If user calls "shoprag create", we'll create an empty shoprag.json if none exists,
 * or ask if they want to overwrite if one does exist. Then we hand off to config editor.
 */
program
    .command('create')
    .description('Create a new shoprag.json in the current directory.')
    .action(async () => {
        const existing = loadShopragJson();
        if (existing) {
            const { overwrite } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'overwrite',
                    message: 'A shoprag.json file already exists. Overwrite it?',
                    default: false
                }
            ]);
            if (!overwrite) {
                console.log('Aborting create. Existing shoprag.json not overwritten.');
                return;
            }
        }
        await createShopragJson();
        await runConfigEditor();
    });

/**
 * Interactive config editor logic (common to "create" and "config" flows).
 */
async function runConfigEditor() {
    let shopragData = loadShopragJson();
    if (!shopragData) {
        console.log('No shoprag.json found. Creating one with defaults...');
        shopragData = {
            Project_Name: 'MyProject',
            ShopRAG: '1.0',
            Shops: [],
            RAGs: []
        };
        saveShopragJson(shopragData);
    }

    let exitEditor = false;
    while (!exitEditor) {
        console.log(`\nCurrent Project Config:`);
        console.log(`Project_Name: ${shopragData.Project_Name}`);
        console.log(`Shops: [${shopragData.Shops.map(s => s.from).join(', ')}]`);
        console.log(`RAGs: [${shopragData.RAGs.map(r => r.to).join(', ')}]`);

        const { editorChoice } = await inquirer.prompt([
            {
                type: 'list',
                name: 'editorChoice',
                message: 'Choose an action:',
                choices: [
                    { name: 'Edit Project Name', value: 'editProjectName' },
                    { name: 'Add Shop', value: 'addShop' },
                    { name: 'Remove Shop', value: 'removeShop' },
                    { name: 'Configure Shop', value: 'configShop' },
                    { name: 'Add RAG', value: 'addRag' },
                    { name: 'Remove RAG', value: 'removeRag' },
                    { name: 'Configure RAG', value: 'configRag' },
                    { name: 'Exit Config Editor', value: 'exit' }
                ]
            }
        ]);

        switch (editorChoice) {
            case 'editProjectName': {
                const { newName } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'newName',
                        message: 'Enter new project name:',
                        default: shopragData.Project_Name
                    }
                ]);
                shopragData.Project_Name = newName;
                saveShopragJson(shopragData);
                break;
            }
            case 'addShop': {
                const { shopPlugin } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'shopPlugin',
                        message: 'Enter the plugin name for this Shop (e.g. "github-repo"):'
                    }
                ]);
                const newShop = {
                    from: shopPlugin,
                    config: {}
                };
                shopragData.Shops.push(newShop);
                saveShopragJson(shopragData);
                console.log(`✅ Added Shop: ${shopPlugin}`);
                break;
            }
            case 'removeShop': {
                if (shopragData.Shops.length === 0) {
                    console.log('No shops to remove.');
                    break;
                }
                const { shopIndex } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'shopIndex',
                        message: 'Select a Shop to remove:',
                        choices: shopragData.Shops.map((s, idx) => ({
                            name: `${idx}. ${s.from}`,
                            value: idx
                        }))
                    }
                ]);
                const removed = shopragData.Shops.splice(shopIndex, 1);
                saveShopragJson(shopragData);
                console.log(`✅ Removed Shop: ${removed[0].from}`);
                break;
            }
            case 'configShop': {
                if (shopragData.Shops.length === 0) {
                    console.log('No shops to configure.');
                    break;
                }
                const { shopIndex } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'shopIndex',
                        message: 'Select a Shop to configure:',
                        choices: shopragData.Shops.map((s, idx) => ({
                            name: `${idx}. ${s.from}`,
                            value: idx
                        }))
                    }
                ]);
                const shop = shopragData.Shops[shopIndex];
                console.log(`\nCurrent config for ${shop.from}:\n${JSON.stringify(shop.config, null, 2)}`);

                let doneShopConfig = false;
                while (!doneShopConfig) {
                    console.log('\nCurrent config paths:');
                    const flatConfig = flattenConfig(shop.config);
                    flatConfig.forEach(path => console.log(path));

                    const { shopConfigChoice } = await inquirer.prompt([
                        {
                            type: 'list',
                            name: 'shopConfigChoice',
                            message: `Configure Shop "${shop.from}"`,
                            choices: [
                                { name: 'Set Config Value by Path', value: 'set' },
                                { name: 'Delete Config Value by Path', value: 'delete' },
                                { name: 'Done', value: 'done' }
                            ]
                        }
                    ]);

                    if (shopConfigChoice === 'set') {
                        const { path } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'path',
                                message: 'Enter the config path to set (e.g., "key" or "key.subkey"):'
                            }
                        ]);
                        const { valueStr } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'valueStr',
                                message: 'Enter the new value as JSON (e.g., "string", 123, true, null, {"key": "value"}, [1,2,3]):',
                                validate: (input) => {
                                    try {
                                        JSON.parse(input);
                                        return true;
                                    } catch (err) {
                                        return 'Invalid JSON. Please try again.';
                                    }
                                }
                            }
                        ]);
                        const value = JSON.parse(valueStr);
                        setByPath(shop.config, path, value);
                        saveShopragJson(shopragData);
                        console.log(`✅ Set config at path "${path}".`);
                    } else if (shopConfigChoice === 'delete') {
                        const { pathToDelete } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'pathToDelete',
                                message: 'Enter the config path to delete (e.g., "key" or "key.subkey"):'
                            }
                        ]);
                        deleteByPath(shop.config, pathToDelete);
                        saveShopragJson(shopragData);
                        console.log(`✅ Deleted config at path "${pathToDelete}".`);
                    } else {
                        doneShopConfig = true;
                    }
                }
                break;
            }
            case 'addRag': {
                const { ragPlugin } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'ragPlugin',
                        message: 'Enter the plugin name for this RAG (e.g. "dir"):'
                    }
                ]);
                const newRag = {
                    to: ragPlugin,
                    config: {}
                };
                shopragData.RAGs.push(newRag);
                saveShopragJson(shopragData);
                console.log(`✅ Added RAG: ${ragPlugin}`);
                break;
            }
            case 'removeRag': {
                if (shopragData.RAGs.length === 0) {
                    console.log('No RAGs to remove.');
                    break;
                }
                const { ragIndex } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'ragIndex',
                        message: 'Select a RAG to remove:',
                        choices: shopragData.RAGs.map((r, idx) => ({
                            name: `${idx}. ${r.to}`,
                            value: idx
                        }))
                    }
                ]);
                const removed = shopragData.RAGs.splice(ragIndex, 1);
                saveShopragJson(shopragData);
                console.log(`✅ Removed RAG: ${removed[0].to}`);
                break;
            }
            case 'configRag': {
                if (shopragData.RAGs.length === 0) {
                    console.log('No RAGs to configure.');
                    break;
                }
                const { ragIndex } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'ragIndex',
                        message: 'Select a RAG to configure:',
                        choices: shopragData.RAGs.map((r, idx) => ({
                            name: `${idx}. ${r.to}`,
                            value: idx
                        }))
                    }
                ]);
                const rag = shopragData.RAGs[ragIndex];
                console.log(`\nCurrent config for ${rag.to}:\n${JSON.stringify(rag.config, null, 2)}`);

                let doneRagConfig = false;
                while (!doneRagConfig) {
                    console.log('\nCurrent config paths:');
                    const flatConfig = flattenConfig(rag.config);
                    flatConfig.forEach(path => console.log(path));

                    const { ragConfigChoice } = await inquirer.prompt([
                        {
                            type: 'list',
                            name: 'ragConfigChoice',
                            message: `Configure RAG "${rag.to}"`,
                            choices: [
                                { name: 'Set Config Value by Path', value: 'set' },
                                { name: 'Delete Config Value by Path', value: 'delete' },
                                { name: 'Done', value: 'done' }
                            ]
                        }
                    ]);

                    if (ragConfigChoice === 'set') {
                        const { path } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'path',
                                message: 'Enter the config path to set (e.g., "key" or "key.subkey"):'
                            }
                        ]);
                        const { valueStr } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'valueStr',
                                message: 'Enter the new value as JSON (e.g., "string", 123, true, null, {"key": "value"}, [1,2,3]):',
                                validate: (input) => {
                                    try {
                                        JSON.parse(input);
                                        return true;
                                    } catch (err) {
                                        return 'Invalid JSON. Please try again.';
                                    }
                                }
                            }
                        ]);
                        const value = JSON.parse(valueStr);
                        setByPath(rag.config, path, value);
                        saveShopragJson(shopragData);
                        console.log(`✅ Set config at path "${path}".`);
                    } else if (ragConfigChoice === 'delete') {
                        const { pathToDelete } = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'pathToDelete',
                                message: 'Enter the config path to delete (e.g., "key" or "key.subkey"):'
                            }
                        ]);
                        deleteByPath(rag.config, pathToDelete);
                        saveShopragJson(shopragData);
                        console.log(`✅ Deleted config at path "${pathToDelete}".`);
                    } else {
                        doneRagConfig = true;
                    }
                }
                break;
            }
            case 'exit': {
                exitEditor = true;
                break;
            }
        }
    }
}

/**
 * Subcommand: shoprag config
 * 
 * Opens the interactive config editor for existing shoprag.json
 * or creates a default if none is found.
 */
program
    .command('config')
    .description('Open the interactive config editor for shoprag.json.')
    .action(async () => {
        await runConfigEditor();
    });

/**
 * The default command: "shoprag" with no subcommand
 *
 * If there's no shoprag.json, we go to "create" flow. If we do have one,
 * we run the main data pipeline: load shops, load rags, manage credentials,
 * gather updates from Shops, apply them to RAGs.
 */
program
    .action(async () => {
        let shopragData = loadShopragJson();
        if (!shopragData) {
            // No shoprag.json => run "create" flow
            console.log('No shoprag.json found. Starting creation wizard...');
            await createShopragJson();
            shopragData = loadShopragJson();
            if (!shopragData) {
                console.error('Failed to create shoprag.json. Exiting.');
                process.exit(1);
            }
        }

        // 1) Load credentials
        let creds = loadOrInitializeCredentials();

        // 2) Determine and install all required plugins upfront
        const shopPlugins = shopragData.Shops.map(s => s.from.startsWith('UNOFFICIAL:') ? s.from.split(':')[1] : `@shoprag/shop-${s.from}`);
        const ragPlugins = shopragData.RAGs.map(r => r.to.startsWith('UNOFFICIAL:') ? r.to.split(':')[1] : `@shoprag/rag-${r.to}`);
        const requiredPlugins = [...new Set([...shopPlugins, ...ragPlugins])]; // Remove duplicates

        console.log('\n🔍 Checking installed plugins...\n');
        const { stdout } = spawnSync('npm', ['list', '-g', '--depth=0', '--json'], { encoding: 'utf-8' });
        const installedPackages = JSON.parse(stdout).dependencies || {};
        const installedPluginNames = Object.keys(installedPackages);
        const missingPlugins = requiredPlugins.filter(p => !installedPluginNames.includes(p));

        if (missingPlugins.length > 0) {
            console.log(`\n🔨 Installing missing plugins: ${missingPlugins.join(', ')}`);
            const installResult = spawnSync('npm', ['install', '-g', ...missingPlugins], { stdio: 'inherit' });
            if (installResult.status !== 0) {
                console.error('Failed to install plugins. Please check the output above.');
                process.exit(1);
            }
            console.log('✅ All plugins installed successfully.\n');
        }

        // 3) Import all shops and rags
        const shops: Shop[] = [];
        console.log('\n🔧 Loading Shop plugins...\n');
        for (const shopDef of shopragData.Shops) {
            const pluginName = shopDef.from.startsWith('UNOFFICIAL:') ? shopDef.from.split(':')[1] : `@shoprag/shop-${shopDef.from}`;
            const pluginModule = await importOrInstallPlugin(pluginName);
            const shopInstance: Shop = pluginModule.default ? new pluginModule.default() : new pluginModule();
            shops.push(shopInstance);
            console.log(`✅ Loaded Shop: ${shopDef.from}`);
        }

        const rags: RAG[] = [];
        console.log('\n🔧 Loading RAG plugins...\n');
        for (const ragDef of shopragData.RAGs) {
            const pluginName = ragDef.to.startsWith('UNOFFICIAL:') ? ragDef.to.split(':')[1] : `@shoprag/rag-${ragDef.to}`;
            const pluginModule = await importOrInstallPlugin(pluginName);
            const ragInstance: RAG = pluginModule.default ? new pluginModule.default() : new pluginModule();
            rags.push(ragInstance);
            console.log(`✅ Loaded RAG: ${ragDef.to}`);
        }

        // 4) For each shop & rag, see what credentials they require, prompt user if missing
        //    Then re-load them so that we can pass them in once everything is available
        for (let i = 0; i < shops.length; i++) {
            const shopDef = shopragData.Shops[i];
            try {
                const neededCreds = shops[i].requiredCredentials();
                await promptForMissingCredentials(shopDef.from, neededCreds, creds);
            } catch (err: any) {
                console.error(`Error retrieving required credentials for shop "${shopDef.from}": ${err}`);
            }
        }

        for (let i = 0; i < rags.length; i++) {
            const ragDef = shopragData.RAGs[i];
            try {
                const neededCreds = rags[i].requiredCredentials();
                await promptForMissingCredentials(ragDef.to, neededCreds, creds);
            } catch (err: any) {
                console.error(`Error retrieving required credentials for RAG "${ragDef.to}": ${err}`);
            }
        }

        // Reload updated creds in case we added some
        creds = loadOrInitializeCredentials();

        // Load lock file
        let lockData = loadOrInitializeLockJson();

        // Handle permissions for unofficial Shops
        for (let i = 0; i < shopragData.Shops.length; i++) {
            const shopDef = shopragData.Shops[i];
            if (shopDef.from.startsWith("UNOFFICIAL:")) {
                const pluginName = shopDef.from;
                const requiredCreds = shops[i].requiredCredentials();
                const permissions = lockData.pluginPermissions[pluginName] || [];
                for (const cred of Object.keys(requiredCreds)) {
                    if (!permissions.includes(cred)) {
                        console.log(`\n⚠️  Warning: The unofficial plugin "${pluginName}" requires access to credential "${cred}".`);
                        console.log(`If you do not trust the publisher of this plugin, do not allow access, especially if the credential is tied to APIs where you could be charged money.`);
                        const { allow } = await inquirer.prompt([
                            {
                                type: 'confirm',
                                name: 'allow',
                                message: `Allow "${pluginName}" to access "${cred}"? (denying will remove the Shop)`,
                                default: false
                            }
                        ]);
                        if (allow) {
                            if (!lockData.pluginPermissions[pluginName]) {
                                lockData.pluginPermissions[pluginName] = [];
                            }
                            lockData.pluginPermissions[pluginName].push(cred);
                        } else {
                            // Remove the shop from configuration
                            shopragData.Shops.splice(i, 1);
                            i--; // Adjust index
                            saveShopragJson(shopragData);
                            console.log(`Removed unofficial Shop "${pluginName}" from configuration.`);
                            // Also remove the shop instance
                            shops.splice(i, 1);
                        }
                    }
                }
            }
        }

        // Handle permissions for unofficial RAGs
        for (let i = 0; i < shopragData.RAGs.length; i++) {
            const ragDef = shopragData.RAGs[i];
            if (ragDef.to.startsWith("UNOFFICIAL:")) {
                const pluginName = ragDef.to;
                const requiredCreds = rags[i].requiredCredentials();
                const permissions = lockData.pluginPermissions[pluginName] || [];
                for (const cred of Object.keys(requiredCreds)) {
                    if (!permissions.includes(cred)) {
                        console.log(`\n⚠️  Warning: The unofficial plugin "${pluginName}" requires access to credential "${cred}".`);
                        console.log(`If you do not trust the publisher of this plugin, do not allow access, especially if the credential is tied to APIs where you could be charged money.`);
                        const { allow } = await inquirer.prompt([
                            {
                                type: 'confirm',
                                name: 'allow',
                                message: `Allow "${pluginName}" to access "${cred}"? (denying will remove the RAG)`,
                                default: false
                            }
                        ]);
                        if (allow) {
                            if (!lockData.pluginPermissions[pluginName]) {
                                lockData.pluginPermissions[pluginName] = [];
                            }
                            lockData.pluginPermissions[pluginName].push(cred);
                        } else {
                            // Remove the rag from configuration
                            shopragData.RAGs.splice(i, 1);
                            i--; // Adjust index
                            saveShopragJson(shopragData);
                            console.log(`Removed unofficial RAG "${pluginName}" from configuration.`);
                            // Also remove the rag instance
                            rags.splice(i, 1);
                        }
                    }
                }
            }
        }

        // 5) Initialize all Shops and RAGs
        console.log('\n🚀 Initializing all Shops and RAGs...\n');
        for (let i = 0; i < shops.length; i++) {
            const shopDef = shopragData.Shops[i];
            const isUnofficial = shopDef.from.startsWith("UNOFFICIAL:");
            const requiredCreds = shops[i].requiredCredentials();
            let allowedCreds: string[] = [];
            if (isUnofficial) {
                const pluginName = shopDef.from;
                const permissions = lockData.pluginPermissions[pluginName] || [];
                allowedCreds = Object.keys(requiredCreds).filter(cred => permissions.includes(cred));
            } else {
                allowedCreds = Object.keys(requiredCreds);
            }
            const credsToPass = Object.fromEntries(
                allowedCreds.map(cred => [cred, creds[cred]])
            );
            await shops[i].init(credsToPass, shopDef.config);
            console.log(`✅ Initialized Shop [${shopDef.from}]`);
        }

        for (let i = 0; i < rags.length; i++) {
            const ragDef = shopragData.RAGs[i];
            const isUnofficial = ragDef.to.startsWith("UNOFFICIAL:");
            const requiredCreds = rags[i].requiredCredentials();
            let allowedCreds: string[] = [];
            if (isUnofficial) {
                const pluginName = ragDef.to;
                const permissions = lockData.pluginPermissions[pluginName] || [];
                allowedCreds = Object.keys(requiredCreds).filter(cred => permissions.includes(cred));
            } else {
                allowedCreds = Object.keys(requiredCreds);
            }
            const credsToPass = Object.fromEntries(
                allowedCreds.map(cred => [cred, creds[cred]])
            );
            await rags[i].init(credsToPass, ragDef.config);
            console.log(`✅ Initialized RAG [${ragDef.to}]`);
        }

        // 6) Gather updates from all Shops
        console.log('\n📡 Gathering updates from Shops...\n');
        const aggregatedUpdates: {
            [fileId: string]: {
                action: 'add' | 'update' | 'delete';
                content?: string;
            };
        } = {};

        for (let i = 0; i < shops.length; i++) {
            const shopDef = shopragData.Shops[i];
            const shopIdentifier = getShopIdentifier(shopDef, i);
            const lastUsed = lockData.shopLastUsed[shopIdentifier] || 0;

            // Build the dictionary of existing files contributed by this shop
            const existingFiles: { [fileId: string]: number } = {};
            for (const [fileId, originObj] of Object.entries(lockData.fileOrigins)) {
                if (originObj.shopIdentifier === shopIdentifier) {
                    existingFiles[fileId] = originObj.lastUpdated;
                }
            }

            // Get the shop updates
            console.log(`🔎 Checking Shop "${shopIdentifier}" for updates...`);
            let shopUpdates: {
                [fileId: string]: { action: 'add' | 'update' | 'delete'; content?: string };
            } = {};
            try {
                shopUpdates = await shops[i].update(lastUsed, existingFiles);
                console.log(`   Found ${Object.keys(shopUpdates).length} updates.`);
            } catch (err: any) {
                console.error(`   Error fetching updates from Shop "${shopIdentifier}":`, err);
                continue;
            }

            // Merge into aggregated updates
            for (const [fileId, updateObj] of Object.entries(shopUpdates)) {
                aggregatedUpdates[fileId] = updateObj;
            }

            // Mark shop as "just used"
            lockData.shopLastUsed[shopIdentifier] = Date.now();

            // Also update lockData's fileOrigins with new info
            // If the action is add/update => set lastUpdated. If delete => remove from fileOrigins.
            for (const [fileId, updateObj] of Object.entries(shopUpdates)) {
                if (updateObj.action === 'delete') {
                    delete lockData.fileOrigins[fileId];
                } else if (updateObj.action === 'add' || updateObj.action === 'update') {
                    lockData.fileOrigins[fileId] = {
                        shopIdentifier,
                        lastUpdated: Date.now()
                    };
                }
            }
        }

        // 7) Apply updates to all RAGs
        if (Object.keys(aggregatedUpdates).length === 0) {
            console.log('\nNo new updates from Shops. RAG updates skipped.\n');
        } else {
            console.log('\n💾 Applying updates to all RAGs...\n');

            for (let i = 0; i < rags.length; i++) {
                const ragDef = shopragData.RAGs[i];
                const ragInstance = rags[i];
                console.log(`🗄  Updating RAG: ${ragDef.to}`);

                // For each file in aggregated updates, call the appropriate method
                for (const [fileId, updateObj] of Object.entries(aggregatedUpdates)) {
                    try {
                        if (updateObj.action === 'delete') {
                            await ragInstance.deleteFile(fileId);
                            console.log(`   🗑  Deleted file: ${fileId}`);
                        } else if (updateObj.action === 'add') {
                            await ragInstance.addFile(fileId, updateObj.content || '');
                            console.log(`   ➕ Added file: ${fileId}`);
                        } else if (updateObj.action === 'update') {
                            await ragInstance.updateFile(fileId, updateObj.content || '');
                            console.log(`   ✏️  Updated file: ${fileId}`);
                        }
                    } catch (err: any) {
                        console.error(`   Error applying update for file "${fileId}" in RAG "${ragDef.to}":`, err);
                    }
                }

                // Finalize edits for this RAG
                await ragInstance.finalize();
                console.log(`✅ Finished updates for RAG: ${ragDef.to}\n`);
            }
        }

        // 8) Save the updated lock file
        saveLockJson(lockData);
        console.log(`\n🎉 All done!`);
    });

/**
 * Parse the CLI arguments and execute.
 */
program.parse(process.argv);

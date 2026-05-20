import { fernConfigJson, PROJECT_CONFIG_FILENAME } from "@fern-api/configuration";
import { extractErrorMessage } from "@fern-api/core-utils";
import { AbsoluteFilePath, dirname, doesPathExist, join, RelativeFilePath } from "@fern-api/fs-utils";
import { CliError, TaskContext } from "@fern-api/task-context";
import { readFile } from "fs/promises";

import { validateSchema } from "../commons/validateSchema.js";
import { ProjectConfigSchema } from "./schema/ProjectConfigSchema.js";

export async function loadProjectConfig({
    directory,
    context
}: {
    directory: AbsoluteFilePath;
    context: TaskContext;
}): Promise<fernConfigJson.ProjectConfig> {
    let pathToConfig = join(directory, RelativeFilePath.of(PROJECT_CONFIG_FILENAME));
    // Some workspaces place fern.config.json next to the fern/ directory rather
    // than inside it (notably workspaces imported from other API-tool
    // conventions). Fall back to the parent directory if the config is not
    // inside.
    if (!(await doesPathExist(pathToConfig))) {
        const parentConfig = join(dirname(directory), RelativeFilePath.of(PROJECT_CONFIG_FILENAME));
        if (await doesPathExist(parentConfig)) {
            pathToConfig = parentConfig;
        }
    }
    const projectConfigStr = await readFile(pathToConfig);
    let projectConfigParsed: unknown;
    try {
        projectConfigParsed = JSON.parse(projectConfigStr.toString()) as unknown;
    } catch (error) {
        throw new CliError({
            message: `Failed to parse ${PROJECT_CONFIG_FILENAME}: ${extractErrorMessage(error)}`,
            code: CliError.Code.ParseError
        });
    }
    const rawProjectConfig = await validateSchema({
        schema: ProjectConfigSchema,
        value: projectConfigParsed,
        context,
        filepathBeingParsed: pathToConfig
    });
    return {
        _absolutePath: pathToConfig,
        rawConfig: rawProjectConfig,
        organization: rawProjectConfig.organization,
        version: rawProjectConfig.version
    };
}

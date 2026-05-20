import { FERN_DIRECTORY, PROJECT_CONFIG_FILENAME } from "@fern-api/configuration";
import { AbsoluteFilePath, dirname, doesPathExist, join, RelativeFilePath } from "@fern-api/fs-utils";
import { findUp } from "find-up";

export async function getFernDirectory(nameOverride?: string): Promise<AbsoluteFilePath | undefined> {
    const fernDirectoryStr = await findUp(nameOverride ?? FERN_DIRECTORY, { type: "directory" });
    if (fernDirectoryStr == null) {
        return undefined;
    }
    const absolutePathToFernDirectory = AbsoluteFilePath.of(fernDirectoryStr);

    if (await doesPathExist(join(absolutePathToFernDirectory, RelativeFilePath.of(PROJECT_CONFIG_FILENAME)))) {
        return absolutePathToFernDirectory;
    }
    // Fallback: some projects (e.g. those imported from other API-tool conventions)
    // place fern.config.json next to the fern/ directory rather than inside it.
    // Accept that layout too.
    const parentDir = dirname(absolutePathToFernDirectory);
    if (await doesPathExist(join(parentDir, RelativeFilePath.of(PROJECT_CONFIG_FILENAME)))) {
        return absolutePathToFernDirectory;
    }
    return undefined;
}

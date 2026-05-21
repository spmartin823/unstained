import { GeneratedGenericAPISdkError } from "@fern-typescript/contexts";

import { GeneratedGenericAPISdkErrorImpl } from "./GeneratedGenericAPISdkErrorImpl.js";

export declare namespace GenericAPISdkErrorGenerator {
    export namespace generateGenericAPISdkError {
        export interface Args {
            errorClassName: string;
            namespaceExport?: string;
        }
    }
}

export class GenericAPISdkErrorGenerator {
    public generateGenericAPISdkError({
        errorClassName,
        namespaceExport
    }: GenericAPISdkErrorGenerator.generateGenericAPISdkError.Args): GeneratedGenericAPISdkError {
        return new GeneratedGenericAPISdkErrorImpl({ errorClassName, namespaceExport });
    }
}

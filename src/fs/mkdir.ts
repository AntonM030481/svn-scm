import { promisify } from "node:util";
import { physicalFs } from "./physical";

export const mkdir = promisify(physicalFs.mkdir);

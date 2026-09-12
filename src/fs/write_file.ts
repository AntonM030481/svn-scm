import { promisify } from "node:util";
import { physicalFs } from "./physical";

export const writeFile = promisify(physicalFs.writeFile);

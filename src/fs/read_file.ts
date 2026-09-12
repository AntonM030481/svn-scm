import { promisify } from "node:util";
import { physicalFs } from "./physical";

export const readFile = promisify(physicalFs.readFile);

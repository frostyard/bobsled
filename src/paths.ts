import { join } from 'node:path';

export function dataPath(filename: string): string {
	return join(process.env.BOBSLED_DATA_DIR ?? './data', filename);
}

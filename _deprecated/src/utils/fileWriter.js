import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

/**
 * Write an observation record to a JSON file
 * @param {import('../models/types.js').ObservationRecord} record
 * @returns {string} The file path that was written
 */
export function writeObservation(record) {
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    let filename = `${record.targetDate}.json`;
    let filePath = path.join(OUTPUT_DIR, filename);

    // If file already exists, append timestamp suffix
    if (fs.existsSync(filePath)) {
        const now = new Date();
        const hhmm = now.toTimeString().slice(0, 5).replace(':', '');
        filename = `${record.targetDate}_${hhmm}.json`;
        filePath = path.join(OUTPUT_DIR, filename);
    }

    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    return filePath;
}

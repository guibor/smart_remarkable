import { createRequestJournal } from "./request-journal.mjs";
import { SelectionService } from "./selection-service.mjs";

export async function createBridgeSelectionService({
  gateway,
  config,
  logger = console,
}) {
  const requestJournal = createRequestJournal({
    rootDirectory: config.requestJournalDir,
    maxEntries: config.requestJournalMaxEntries,
  });
  await requestJournal.prepare();
  return new SelectionService({
    gateway,
    config,
    requestJournal,
    logger,
  });
}

import { createRequestJournal } from "./request-journal.mjs";
import { SelectionService } from "./selection-service.mjs";
import {
  ORIGIN_CAPABILITIES_METHOD,
  verifyPluginCapabilities,
} from "./source-provenance.mjs";

function currentConnectionGeneration(gateway) {
  const generation = gateway.getConnectionGeneration();
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("OpenClaw Gateway is not connected");
  }
  return generation;
}

export function createCapabilityReadiness({ gateway, timeoutMs }) {
  if (
    !gateway ||
    typeof gateway.getConnectionGeneration !== "function" ||
    typeof gateway.requestForGeneration !== "function" ||
    typeof gateway.subscribeConnection !== "function"
  ) {
    throw new Error("Gateway connection generation tracking is unavailable");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Capability probe timeout must be a positive integer");
  }

  let closed = false;
  let verifiedGeneration = null;
  let inFlightProbe = null;
  const unsubscribe = gateway.subscribeConnection(() => {
    verifiedGeneration = null;
  });

  const ensureReady = async () => {
    if (closed) {
      throw new Error("OpenClaw capability readiness is closed");
    }
    const generation = currentConnectionGeneration(gateway);
    if (verifiedGeneration === generation) {
      return generation;
    }
    if (inFlightProbe?.generation === generation) {
      return inFlightProbe.promise;
    }

    const probe = (async () => {
      const capabilities = await gateway.requestForGeneration(
        generation,
        ORIGIN_CAPABILITIES_METHOD,
        {},
        { timeoutMs },
      );
      verifyPluginCapabilities(capabilities);
      if (currentConnectionGeneration(gateway) !== generation) {
        throw new Error(
          "OpenClaw Gateway connection changed during capability probe",
        );
      }
      verifiedGeneration = generation;
      return generation;
    })();
    inFlightProbe = { generation, promise: probe };
    try {
      return await probe;
    } finally {
      if (inFlightProbe?.promise === probe) {
        inFlightProbe = null;
      }
    }
  };

  return Object.freeze({
    ensureReady,
    isReady() {
      if (closed) {
        return false;
      }
      const generation = gateway.getConnectionGeneration();
      return (
        Number.isSafeInteger(generation) &&
        generation > 0 &&
        verifiedGeneration === generation
      );
    },
    assertGeneration(generation) {
      if (
        closed ||
        !Number.isSafeInteger(generation) ||
        generation <= 0 ||
        verifiedGeneration !== generation ||
        gateway.getConnectionGeneration() !== generation
      ) {
        throw new Error(
          "OpenClaw Gateway capability generation is not current",
        );
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      verifiedGeneration = null;
      unsubscribe();
    },
  });
}

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
  const capabilityReadiness = createCapabilityReadiness({
    gateway,
    timeoutMs: config.sendTimeoutMs,
  });
  try {
    await capabilityReadiness.ensureReady();
  } catch (error) {
    capabilityReadiness.close();
    throw error;
  }
  return new SelectionService({
    gateway,
    config,
    requestJournal,
    capabilityReadiness,
    logger,
  });
}

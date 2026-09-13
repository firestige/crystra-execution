if (process.env.CRYSTRA_RELEASE_PACK_MODE !== "verified-builder") {
  throw new Error("DIRECT_SOURCE_PACK_PROHIBITED");
}

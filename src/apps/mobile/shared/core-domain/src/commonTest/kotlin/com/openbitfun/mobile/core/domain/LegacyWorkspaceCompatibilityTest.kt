package com.openbitfun.mobile.core.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LegacyWorkspaceCompatibilityTest {
    private val local = RemoteWorkspaceIdentity("/repo", null, null, "local-id")
    private val ssh = RemoteWorkspaceIdentity("/repo", "saved", "host", "ssh-id")
    private val other = RemoteWorkspaceIdentity("/other", null, null, "other-id")
    private val catalog = listOf(local, ssh, other)

    @Test
    fun knownIdResolvesToItsRowRegardlessOfTheCarriedPath() {
        val stale = RemoteWorkspaceIdentity("/moved", "wrong", "wrong-host", "ssh-id")
        assertEquals(WorkspaceReferenceResolution.Resolved(ssh), LegacyWorkspaceCompatibility.resolveReference(stale, catalog))
        assertEquals(ssh, LegacyWorkspaceCompatibility.resolve(stale, catalog))
    }

    @Test
    fun unknownIdIsAnErrorStateAndNeverFallsBackToThePath() {
        val gone = RemoteWorkspaceIdentity("/repo", null, null, "deleted-id")
        val resolution = LegacyWorkspaceCompatibility.resolveReference(gone, listOf(local, other))
        assertEquals(WorkspaceReferenceResolution.UnknownId("deleted-id"), resolution)
        assertTrue(resolution.isUnknownId)
        assertNull(resolution.identityOrNull)
        assertNull(LegacyWorkspaceCompatibility.resolve(gone, listOf(local, other)))
        assertEquals(WorkspaceReferenceResolution.UnknownId("deleted-id"), LegacyWorkspaceCompatibility.resolveById("deleted-id", catalog))
        assertIs<WorkspaceReferenceResolution.UnknownId>(LegacyWorkspaceCompatibility.resolveById("  ", catalog))
    }

    @Test
    fun legacyMissAndAmbiguityAreDistinctFromUnknownId() {
        val miss = LegacyWorkspaceCompatibility.resolveReference(RemoteWorkspaceIdentity("/missing", null, null), catalog)
        assertEquals(WorkspaceReferenceResolution.Unresolved, miss)
        assertFalse(miss.isUnknownId)
        val ambiguous = LegacyWorkspaceCompatibility.resolveReference(RemoteWorkspaceIdentity("/repo/", null, null), catalog)
        assertEquals(WorkspaceReferenceResolution.Ambiguous(listOf(local, ssh)), ambiguous)
        assertNull(LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", null, null), catalog))
    }

    @Test
    fun savedConnectionAndHostNarrowLegacyCandidates() {
        assertEquals(ssh, LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", "saved", null), catalog))
        assertEquals(ssh, LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", null, "host"), catalog))
        assertEquals(ssh, LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", " saved ", " host "), catalog))
        assertNull(LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", "unsaved", null), catalog))
        assertNull(LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", "saved", "elsewhere"), catalog))
        // Blank values are absent, as on the host.
        assertEquals(WorkspaceReferenceResolution.Ambiguous(listOf(local, ssh)),
            LegacyWorkspaceCompatibility.resolveReference(RemoteWorkspaceIdentity("/repo", "  ", ""), catalog))
    }

    @Test
    fun bareLocalhostHostIsIgnoredOnlyWithoutAConnectionId() {
        // 1.0.0 stamped `localhost` on local workspaces: without a connection it says nothing.
        assertEquals(local, LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", null, "localhost"), listOf(local, other)))
        val localhostSsh = RemoteWorkspaceIdentity("/repo", "loop", "localhost", "loop-id")
        val mixed = listOf(local, localhostSsh)
        assertEquals(WorkspaceReferenceResolution.Ambiguous(mixed),
            LegacyWorkspaceCompatibility.resolveReference(RemoteWorkspaceIdentity("/repo", null, "localhost"), mixed))
        // With a connection id, localhost is a real ssh host and must match.
        assertEquals(localhostSsh, LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", "loop", "localhost"), mixed))
        assertNull(LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity("/repo", "loop", "localhost"), listOf(local, ssh)))
    }

    @Test
    fun sessionOwnershipComparesIdsOnlyWhenBothSidesHaveThem() {
        val session = RemoteSession("s", "Session", "code", "idle", "", "", 0, "/repo", null,
            workspaceIdentity = RemoteWorkspaceIdentity("/renamed", null, null, "ssh-id"))
        assertTrue(session.belongsTo(ssh, catalog))
        assertFalse(session.belongsTo(local, catalog))
        // The ID decides even when the catalog no longer lists the row.
        assertTrue(session.belongsTo(ssh, emptyList()))
        // An unknown owned ID never adopts the same-path row.
        val orphan = session.copy(workspaceIdentity = RemoteWorkspaceIdentity("/repo", null, null, "deleted-id"))
        assertFalse(orphan.belongsTo(RemoteWorkspaceIdentity("/repo", null, null), listOf(RemoteWorkspaceIdentity("/repo", null, null))))
        assertFalse(orphan.belongsTo(local, catalog))
    }

    @Test
    fun ownedLegacyIdentityResolvesThroughTheCatalogToAnIdRow() {
        val session = RemoteSession("s", "Session", "code", "idle", "", "", 0, "/repo", null,
            workspaceIdentity = RemoteWorkspaceIdentity("/repo", "saved", "host"))
        assertTrue(session.belongsTo(ssh, catalog))
        assertFalse(session.belongsTo(local, catalog))
        val unscoped = session.copy(workspaceIdentity = RemoteWorkspaceIdentity("/repo", null, null))
        assertFalse(unscoped.belongsTo(local, catalog), "ambiguous legacy roots stay unresolved")
        assertTrue(unscoped.belongsTo(local, listOf(local, other)))
    }

    @Test
    fun sameWorkspaceComparesIdsFirstAndTheTripleOnlyWhenBothLackAnId() {
        val byId = RemoteWorkspaceIdentity("/repo", null, null, "ws-1")
        assertTrue(byId.sameWorkspace(RemoteWorkspaceIdentity("/moved", "other", "other-host", "ws-1")))
        assertFalse(byId.sameWorkspace(RemoteWorkspaceIdentity("/repo", null, null, "ws-2")), "same path, different ID")
        val legacy = RemoteWorkspaceIdentity("/repo", "saved", "host")
        // A pre-ID cache row against a live ID-bearing workspace: only the legacy triple is available.
        assertFalse(byId.sameWorkspace(legacy), "different triple, so no match")
        assertTrue(RemoteWorkspaceIdentity("/repo", "saved", "host", "ws-1").sameWorkspace(legacy))
        assertTrue(legacy.sameWorkspace(RemoteWorkspaceIdentity("/repo/", "saved", "host")))
        assertFalse(legacy.sameWorkspace(RemoteWorkspaceIdentity("/repo", "saved", "elsewhere")))
        assertFalse(legacy.sameWorkspace(RemoteWorkspaceIdentity("/repo", null, null)))
    }

    @Test
    fun capabilityGateReadsTheHostList() {
        assertTrue(WorkspaceReferencePolicy.supportsWorkspaceIdReferences(listOf("dialog_steer_v1", "workspace_id_references_v1")))
        assertFalse(WorkspaceReferencePolicy.supportsWorkspaceIdReferences(listOf("dialog_steer_v1")))
        assertFalse(WorkspaceReferencePolicy.supportsWorkspaceIdReferences(emptyList()))
    }
}

package com.openbitfun.mobile.core.feature.connection

import kotlin.test.Test
import kotlin.test.assertEquals

class RemoteControlPresenterTest {
    @Test
    fun withNothingPairedTheCardHasNoDesktopAndNoAction() {
        val summary = RemoteControlPresenter.summarize(
            accountDeviceId = "",
            accountDeviceName = "",
            accountPhase = ConnectionPhase.IDLE,
        )

        assertEquals(RemoteControlSource.NONE, summary.source)
        assertEquals("", summary.desktopName)
        assertEquals(RemoteControlAction.NONE, summary.action)
    }

    @Test
    fun aSelectedAccountDeviceIsTheDesktopWhenNoRoomIsPaired() {
        val summary = RemoteControlPresenter.summarize(
            accountDeviceId = "device-1",
            accountDeviceName = "Studio",
            accountPhase = ConnectionPhase.CONNECTED,
        )

        assertEquals(RemoteControlSource.ACCOUNT_DEVICE, summary.source)
        assertEquals("Studio", summary.desktopName)
        assertEquals(ConnectionPhase.CONNECTED, summary.phase)
        assertEquals(RemoteControlAction.DISCONNECT, summary.action)
    }

    @Test
    fun aDroppedAccountDeviceLinkOffersReconnect() {
        for (phase in listOf(ConnectionPhase.IDLE, ConnectionPhase.DISCONNECTED, ConnectionPhase.FAILED)) {
            val summary = RemoteControlPresenter.summarize(
                accountDeviceId = "device-1",
                accountDeviceName = "Studio",
                accountPhase = phase,
            )

            assertEquals(RemoteControlAction.RECONNECT, summary.action, phase.name)
        }
    }

    @Test
    fun aComingBackAccountDeviceLinkCanStillBeLeft() {
        val summary = RemoteControlPresenter.summarize(
            accountDeviceId = "device-1",
            accountDeviceName = "Studio",
            accountPhase = ConnectionPhase.RECONNECTING,
        )

        assertEquals(RemoteControlAction.DISCONNECT, summary.action)
    }

    @Test
    fun aDeviceTheRelayOnlyKnowsByIdIsNamedByThatId() {
        val summary = RemoteControlPresenter.summarize(
            accountDeviceId = "device-1",
            accountDeviceName = "  ",
            accountPhase = ConnectionPhase.RECONNECTING,
        )

        assertEquals("device-1", summary.desktopName)
    }

    @Test
    fun aSelectedAccountDevicePublishesItsTransportPhase() {
        val summary = RemoteControlPresenter.summarize(
            accountDeviceId = "device-1",
            accountDeviceName = "Studio",
            accountPhase = ConnectionPhase.RECONNECTING,
        )

        assertEquals(ConnectionPhase.RECONNECTING, summary.phase)
    }
}

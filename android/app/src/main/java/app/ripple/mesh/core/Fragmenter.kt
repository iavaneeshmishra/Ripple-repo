package app.ripple.mesh.core

import java.nio.ByteBuffer

/** BLE frame fragmentation per PROTOCOL.md §5.2. */
object Fragmenter {
    const val HEADER = 4
    const val MAX_FRAGMENTS = 255

    /** Largest complete packet that fits this frame size and the 8-bit fragment count. */
    fun maxPacketSize(frameSize: Int): Int {
        require(frameSize > HEADER) { "frame too small" }
        val chunkSize = minOf(frameSize - HEADER, Protocol.MAX_PACKET)
        return minOf(Protocol.MAX_PACKET, chunkSize * MAX_FRAGMENTS)
    }

    fun canFragment(packetSize: Int, frameSize: Int): Boolean =
        frameSize > HEADER && packetSize in 0..Protocol.MAX_PACKET && packetSize <= maxPacketSize(frameSize)

    fun fragment(packet: ByteArray, frameSize: Int, streamId: Int): List<ByteArray> {
        require(packet.size <= Protocol.MAX_PACKET) { "packet too large" }
        require(frameSize > HEADER) { "frame too small" }
        require(streamId in 0..0xffff) { "stream id out of range" }
        val chunk = frameSize - HEADER
        val total = if (packet.isEmpty()) 1 else 1 + (packet.size - 1) / chunk
        require(total <= MAX_FRAGMENTS) { "packet needs too many fragments" }
        return List(total) { i ->
            val start = i * chunk
            val end = minOf(packet.size, start + chunk)
            ByteBuffer.allocate(HEADER + (end - start))
                .putShort(streamId.toShort()).put(i.toByte()).put(total.toByte())
                .put(packet, start, end - start)
                .array()
        }
    }
}

/** Reassembles frames from one link. Not thread-safe; owned by the link's single worker. */
class Reassembler(
    private val ttlMs: Long = Protocol.REASSEMBLY_TTL_MS,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000L },
) {
    private class Stream(val total: Int, val startedAt: Long) {
        val parts = arrayOfNulls<ByteArray>(total)
        var have = 0
        var bufferedBytes = 0
    }

    private val streams = HashMap<Int, Stream>()
    private var bufferedBytes = 0

    init {
        require(ttlMs > 0) { "reassembly ttl must be positive" }
    }

    private fun removeStream(streamId: Int) {
        streams.remove(streamId)?.let { bufferedBytes -= it.bufferedBytes }
    }

    /** Purged on each push; the stream deadline is fixed by its first fragment. */
    private fun removeExpired(now: Long) {
        val expired = streams.entries
            .filter { now - it.value.startedAt >= ttlMs }
            .map { it.key }
        expired.forEach(::removeStream)
    }

    /** @return the complete packet when the last fragment arrives, else null. */
    fun push(frame: ByteArray): ByteArray? {
        val now = clock()
        removeExpired(now)
        if (frame.size < Fragmenter.HEADER) return null
        val streamId = ((frame[0].toInt() and 0xff) shl 8) or (frame[1].toInt() and 0xff)
        val index = frame[2].toInt() and 0xff
        val total = frame[3].toInt() and 0xff
        if (total == 0 || index >= total) return null

        val partSize = frame.size - Fragmenter.HEADER
        if (partSize > Protocol.MAX_PACKET) {
            removeStream(streamId)
            return null
        }

        var stream = streams[streamId]
        if (stream != null && stream.total != total) {
            removeStream(streamId)
            stream = null
        }

        // Complete packets need no retained stream or active-stream slot.
        if (total == 1) {
            removeStream(streamId)
            return frame.copyOfRange(Fragmenter.HEADER, frame.size)
        }

        val active = stream ?: run {
            if (streams.size >= Protocol.MAX_REASSEMBLY_STREAMS) return null
            Stream(total, now).also { streams[streamId] = it }
        }

        if (active.parts[index] != null) return null
        if (partSize > Protocol.MAX_PACKET - active.bufferedBytes ||
            partSize > Protocol.MAX_REASSEMBLY_BYTES - bufferedBytes
        ) {
            // Drop the whole stream rather than pinning a partial allocation at the cap.
            removeStream(streamId)
            return null
        }

        val part = frame.copyOfRange(Fragmenter.HEADER, frame.size)
        active.parts[index] = part
        active.have++
        active.bufferedBytes += part.size
        bufferedBytes += part.size
        if (active.have < total) return null

        val out = ByteArray(active.bufferedBytes)
        var offset = 0
        active.parts.forEach {
            val bytes = checkNotNull(it)
            bytes.copyInto(out, offset)
            offset += bytes.size
        }
        removeStream(streamId)
        return out
    }
}

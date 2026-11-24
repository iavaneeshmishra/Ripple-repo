package app.ripple.mesh.data

import app.ripple.mesh.core.Identity
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Test

class IdentityStoreTest {
    @Test fun `missing legacy keystore alias may create a first identity`() {
        val created = Identity.generate()
        var createCalls = 0
        val result = IdentityStore.legacyOrCreate(
            readLegacy = { null },
            create = { createCalls++; created },
        )
        assertSame(created, result)
        assertEquals(1, createCalls)
    }

    @Test fun `legacy keystore read failure never falls through to a replacement identity`() {
        val failure = IllegalStateException("keystore unavailable")
        var createCalled = false
        try {
            IdentityStore.legacyOrCreate(
                readLegacy = { throw failure },
                create = { createCalled = true; Identity.generate() },
            )
            throw AssertionError("keystore error should propagate")
        } catch (actual: IllegalStateException) {
            assertSame(failure, actual)
        }
        assertFalse(createCalled)
    }

    @Test fun `identity scalar is encrypted before persistence`() {
        val scalar = ByteArray(32) { it.toByte() }
        val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
        var ciphertext: String? = null
        var iv: String? = null
        IdentityStore.writeWrappedScalar(scalar, keyProvider = { key }) { encoded, nonce ->
            ciphertext = encoded
            iv = nonce
            true
        }
        val encoded = checkNotNull(ciphertext)
        val nonce = checkNotNull(iv)
        assertEquals(48, Base64.getDecoder().decode(encoded).size) // 32-byte scalar plus 16-byte GCM tag
        assertEquals(12, Base64.getDecoder().decode(nonce).size)

        val decrypt = Cipher.getInstance("AES/GCM/NoPadding")
        decrypt.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.getDecoder().decode(nonce)))
        assertArrayEquals(scalar, decrypt.doFinal(Base64.getDecoder().decode(encoded)))
    }

    @Test fun `keystore failure does not persist an unwrapped identity scalar`() {
        val failure = IllegalStateException("Keystore unavailable")
        var persistCalled = false
        try {
            IdentityStore.writeWrappedScalar(
                scalar = ByteArray(32),
                keyProvider = { throw failure },
                persist = { _, _ -> persistCalled = true; true },
            )
            throw AssertionError("Keystore failure should propagate")
        } catch (actual: IllegalStateException) {
            assertSame(failure, actual)
        }
        assertFalse(persistCalled)
    }

    @Test fun `preference persistence failure is not reported as success`() {
        try {
            IdentityStore.writeWrappedScalar(
                scalar = ByteArray(32),
                keyProvider = { SecretKeySpec(ByteArray(32), "AES") },
                persist = { _, _ -> false },
            )
            throw AssertionError("failed persistence should throw")
        } catch (expected: IllegalStateException) {
            assertEquals("identity could not be saved securely", expected.message)
        }
    }
}

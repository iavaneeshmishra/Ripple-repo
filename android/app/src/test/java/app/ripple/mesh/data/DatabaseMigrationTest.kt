package app.ripple.mesh.data

import androidx.sqlite.db.SupportSQLiteDatabase
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DatabaseMigrationTest {
    @Test fun `v1 to v2 migration only adds the SOS history table`() {
        val statements = mutableListOf<String>()
        val database = Proxy.newProxyInstance(
            SupportSQLiteDatabase::class.java.classLoader,
            arrayOf(SupportSQLiteDatabase::class.java),
        ) { _, method, args ->
            if (method.name == "execSQL") {
                statements += args!![0] as String
                null
            } else {
                throw AssertionError("unexpected migration database call: ${method.name}")
            }
        } as SupportSQLiteDatabase

        assertEquals(1, MIGRATION_1_2.startVersion)
        assertEquals(2, MIGRATION_1_2.endVersion)
        MIGRATION_1_2.migrate(database)
        assertEquals(1, statements.size)
        val sql = statements.single()
        assertTrue(sql.startsWith("CREATE TABLE IF NOT EXISTS `sos_beacons`"))
        for (column in listOf("messageId", "fromNodeId", "fromName", "text", "latE7", "lngE7", "accuracyMeters", "verified", "timestamp")) {
            assertTrue("missing SOS column $column", sql.contains("`$column`"))
        }
        assertFalse(sql.contains("DROP TABLE"))
    }
}

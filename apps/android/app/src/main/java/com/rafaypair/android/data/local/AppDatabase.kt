package com.rafaypair.android.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(
    tableName = "care_drafts",
    indices = [Index(value = ["ownerUserId", "updatedAtEpochMillis"])],
)
data class CareDraftEntity(
    @androidx.room.PrimaryKey val clientRequestId: String,
    val ownerUserId: String,
    val pairId: String,
    val kind: String,
    val encryptedMessage: String?,
    val state: String,
    val lastError: String?,
    val createdAtEpochMillis: Long,
    val updatedAtEpochMillis: Long,
)

@Entity(
    tableName = "care_summaries",
    indices = [Index(value = ["ownerUserId", "createdAtEpochMillis"])],
)
data class CareSummaryEntity(
    @androidx.room.PrimaryKey val requestId: String,
    val ownerUserId: String,
    val clientRequestId: String?,
    val kind: String,
    val encryptedMessage: String?,
    val direction: String,
    val status: String,
    val encryptedOtherDisplayName: String?,
    val createdAtEpochMillis: Long,
    val respondedAtEpochMillis: Long?,
)

@Dao
interface CareDao {
    @Query(
        "SELECT * FROM care_drafts WHERE ownerUserId = :ownerUserId " +
            "ORDER BY updatedAtEpochMillis DESC",
    )
    fun observeDrafts(ownerUserId: String): Flow<List<CareDraftEntity>>

    @Query(
        "SELECT * FROM care_summaries WHERE ownerUserId = :ownerUserId " +
            "ORDER BY createdAtEpochMillis DESC",
    )
    fun observeSummaries(ownerUserId: String): Flow<List<CareSummaryEntity>>

    @Query(
        "SELECT * FROM care_drafts WHERE ownerUserId = :ownerUserId " +
            "AND state IN ('QUEUED', 'FAILED') ORDER BY createdAtEpochMillis ASC",
    )
    suspend fun pendingDrafts(ownerUserId: String): List<CareDraftEntity>

    @Query(
        "SELECT * FROM care_drafts WHERE clientRequestId = :clientRequestId " +
            "AND ownerUserId = :ownerUserId LIMIT 1",
    )
    suspend fun draftForOwner(clientRequestId: String, ownerUserId: String): CareDraftEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertDraft(entity: CareDraftEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSummaries(entities: List<CareSummaryEntity>)

    @Query(
        "DELETE FROM care_drafts WHERE clientRequestId = :clientRequestId " +
            "AND ownerUserId = :ownerUserId",
    )
    suspend fun deleteDraftForOwner(clientRequestId: String, ownerUserId: String)

    @Query("DELETE FROM care_drafts WHERE ownerUserId = :ownerUserId")
    suspend fun deleteDraftsForOwner(ownerUserId: String)

    @Query("DELETE FROM care_summaries WHERE ownerUserId = :ownerUserId")
    suspend fun deleteSummariesForOwner(ownerUserId: String)
}

@Database(
    entities = [CareDraftEntity::class, CareSummaryEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class RafayPairDatabase : RoomDatabase() {
    abstract fun careDao(): CareDao
}

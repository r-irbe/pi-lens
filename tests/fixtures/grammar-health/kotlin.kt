package corpus

import kotlinx.coroutines.delay

sealed class Result {
    data class Ok(val value: Int) : Result()
    data class Err(val message: String) : Result()
}

interface Source {
    suspend fun fetch(id: Int): Result
}

class Repository(private val source: Source) {
    suspend fun total(ids: List<Int>): Int {
        var sum = 0
        for (id in ids) {
            when (val result = source.fetch(id)) {
                is Result.Ok -> sum += result.value
                is Result.Err -> println("error: ${result.message}")
            }
        }
        delay(1)
        return sum
    }
}

fun main() {
    val squares = (1..3).map { it * it }.filter { it % 2 == 1 }
    println(squares)
}

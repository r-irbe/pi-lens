from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class Account:
    owner: str
    balance: float = 0.0
    history: list[float] = field(default_factory=list)

    def deposit(self, amount: float) -> "Account":
        if amount <= 0:
            raise ValueError(f"bad amount: {amount!r}")
        self.balance += amount
        self.history.append(amount)
        return self


async def total(accounts: list[Account]) -> float:
    await asyncio.sleep(0)
    return sum(a.balance for a in accounts if a.balance > 0)


if __name__ == "__main__":
    accounts = [Account("a").deposit(1), Account("b").deposit(2)]
    squares = {n: n**2 for n in range(3)}
    print(asyncio.run(total(accounts)), squares, [x for x in squares if x % 2])

import asyncio
from sqlalchemy import select
from app.core.security import hash_token
from app.db.session import session_scope
from app.models.user import UserSession

async def main():
    async with session_scope() as s:
        rows = (await s.execute(select(UserSession))).scalars().all()
        print("sessions:", len(rows))
        for r in rows[:3]:
            print("  ", r.id, "hash:", r.refresh_token_hash[:16], "revoked:", r.revoked_at)

asyncio.run(main())

import asyncio
from sqlalchemy import select
from app.db.session import session_scope
from app.core.security import hash_password
from app.models.user import User

async def main():
    async with session_scope() as s:
        u = (await s.execute(select(User).where(User.email == "tester@pulse-shop.ru"))).scalar_one_or_none()
        if u is None:
            print("нет такого пользователя"); return
        u.password_hash = hash_password("parol123")
        await s.commit()
        print("пароль сброшен на parol123 для", u.email)
asyncio.run(main())

from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import SecretStr


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    supabase_url: str = ""
    supabase_service_role_key: SecretStr = SecretStr("")
    thermowatch_api_token: SecretStr = SecretStr("")
    firms_map_key: SecretStr = SecretStr("")


@lru_cache
def get_settings() -> Settings:
    return Settings()

# Firebase – společná databáze pro všechny uživatele

Aby **všichni měli po otevření aplikace stejná data**, musí aplikace běžet na Firebase Realtime Database. Aplikace se už při prvním otevření **automaticky pokusí připojit** k výchozímu Firebase projektu v kódu. Pokud vidíte „Lokální režim“, je potřeba v Firebase povolit čtení a zápis.

## Kroky (stačí jednou)

### 1. Otevřete Firebase Console
- Přihlaste se na [https://console.firebase.google.com](https://console.firebase.google.com)
- Vyberte projekt **pavel-vrtal-rybari-registrace** (nebo ten, jehož Database URL a API Key jsou v aplikaci)

### 2. Zapněte Realtime Database (pokud ještě není)
- V levém menu: **Build** → **Realtime Database**
- Pokud databáze neexistuje: **Create Database** → zvolte lokaci (např. europe-west1) → **Next** → režim **Start in test mode** nebo **Start in locked mode** (pak viz krok 3)

### 3. Nastavte pravidla (Rules)
- V Realtime Database klikněte na záložku **Rules**
- **Smažte** stávající pravidla a vložte obsah souboru **firebase-database-rules.json** z tohoto projektu (nebo níže)
- Klikněte na **Publish**

Pravidla pro Hluboček (čtení a zápis pro všechny uživatele aplikace):

```json
{
  "rules": {
    "fishers": { ".read": true, ".write": true },
    "checkins": { ".read": true, ".write": true },
    "catches": { ".read": true, ".write": true },
    "visitors": { ".read": true, ".write": true }
  }
}
```

### 4. Ověření
- Otevřete aplikaci na **https://hlubocek.github.io**
- Měli byste vidět zelený pruh: **„Firebase – data sdílena v reálném čase“** místo „Lokální režim“
- Na jiném zařízení nebo v jiném prohlížeči otevřete stejnou adresu – data budou stejná

---

**Poznámka:** Tato pravidla umožňují čtení a zápis každému, kdo má odkaz na aplikaci. Pro uzavřenou skupinu (rybářský spolek) je to obvykle v pořádku. Pokud budete chtít přístup omezit (např. jen po přihlášení), lze pravidla později upravit.

---

## Databáze s názvem „hlubocek“

Ano, možné to je. Firebase projekt (a tím i „název“ databáze) může být **hlubocek** místo pavel-vrtal-rybari-registrace.

### Postup

1. **Firebase Console** → [console.firebase.google.com](https://console.firebase.google.com) → **Add project** / Přidat projekt.
2. **Název projektu:** např. Hluboček. **Project ID** zvolte **hlubocek** (nebo **hlubocek-ryby**, pokud je „hlubocek“ už obsazené).
3. Dokončete vytvoření projektu. V **Build** → **Realtime Database** zvolte **Create Database**, lokaci např. europe-west1, pak **Next**.
4. Záložka **Rules** → vložte pravidla z **firebase-database-rules.json** → **Publish**.
5. **Project settings** (ozubené kolečko) → **General** → sekce „Your apps“ → pokud tam žádná webová aplikace není, přidejte **Add app** → Web (</>). Zapište si:
   - **Web API Key**
   - V **Realtime Database** v levém menu zkopírujte **Database URL** (např. `https://hlubocek-default-rtdb.europe-west1.firebasedatabase.app`).
6. V projektu aplikace v souboru **app.js** najděte `const FB_CONFIG = { ... }` a přepište na:
   - `apiKey`: vaše Web API Key  
   - `databaseURL`: vaše Database URL  
   - `projectId`: **hlubocek** (nebo hlubocek-ryby)
7. Aplikaci znovu nasaďte na web (push na GitHub) nebo uložte upravený **app.js** do stažené složky. Od té chvíle bude aplikace (web i stažená) používat databázi **hlubocek**.

Pokud pošlete Web API Key a Database URL (bez hesla, jde o veřejné údaje pro webovou appku), lze v **app.js** výchozí `FB_CONFIG` přepsat za vás a databáze bude pojmenovaná hlubocek.

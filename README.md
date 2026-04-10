# 🦷 Chatbot WhatsApp - Odontología MediTrust

Chatbot para WhatsApp que permite agendar citas, consultar servicios y responder preguntas frecuentes de tu clínica dental.

---

## 📋 REQUISITOS PREVIOS

- Node.js v18 o superior → https://nodejs.org
- XAMPP con MySQL corriendo
- WhatsApp Business en tu celular

---

## 🚀 INSTALACIÓN PASO A PASO

### 1️⃣ Crear la base de datos

1. Abre XAMPP y enciende **Apache** y **MySQL**
2. Ve a `http://localhost/phpmyadmin`
3. Clic en **"Nueva"** (panel izquierdo)
4. Ve a la pestaña **SQL**
5. Copia y pega todo el contenido de `database.sql`
6. Clic en **"Continuar"**

### 2️⃣ Instalar dependencias

Abre una terminal (CMD o PowerShell) en la carpeta del proyecto:

```bash
npm install
```

### 3️⃣ Configurar tu clínica

Abre `index.js` y edita estas secciones:

```js
// Tu contraseña de MySQL (normalmente vacía en XAMPP)
password: '',

// Nombre de tu clínica en getMenu()
'🦷 *Bienvenido a Odontología MediTrust* 🦷'

// Precios en getServicios()
// Dirección y teléfono en getHorarios()
```

### 4️⃣ Iniciar el bot

```bash
npm start
```

### 5️⃣ Conectar WhatsApp

1. Aparecerá un **código QR** en la terminal
2. Abre WhatsApp en tu celular → Dispositivos vinculados
3. Escanea el código QR
4. ✅ ¡El bot ya está funcionando!

---

## 💬 FLUJO DEL CHATBOT

```
Cliente escribe cualquier mensaje
         ↓
    Menú principal
    1. Agendar cita
    2. Ver mis citas
    3. Cancelar cita
    4. Servicios
    5. FAQ
    6. Horarios
         ↓
  [Si elige "Agendar cita"]
    → Nombre
    → Servicio
    → Fecha
    → Hora
    → Confirmación
    → ✅ Cita guardada en MySQL
```

---

## 📁 ESTRUCTURA DEL PROYECTO

```
dental-bot/
├── index.js          ← Código principal del bot
├── package.json      ← Dependencias
├── database.sql      ← Script para crear la BD
├── auth_info/        ← Se crea automáticamente (sesión WhatsApp)
└── README.md         ← Este archivo
```

---

## 🔧 SOLUCIÓN DE PROBLEMAS

**Error: Cannot connect to MySQL**
- Verifica que XAMPP MySQL esté encendido
- Verifica usuario/contraseña en `index.js`

**El QR expiró**
- Borra la carpeta `auth_info/`
- Reinicia con `npm start`

**El bot se desconecta**
- Reinstala: `npm install`
- Asegúrate de tener Node.js v18+

---

## 📞 PERSONALIZACIÓN

Para agregar más servicios, edita la función `getServicios()` en `index.js`.

Para cambiar horarios disponibles, edita el objeto `horas` en el paso `cita_hora`.

---

## ⚠️ IMPORTANTE

- Este bot usa **Baileys** (librería no oficial de WhatsApp)
- Mantén el celular con WhatsApp conectado a internet
- No uses el mismo número para chatear normalmente mientras el bot está activo
- Para uso comercial serio considera la **WhatsApp Business API oficial**

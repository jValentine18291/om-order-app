const { query } = require("./data/autocountConnection");
(async () => {
  const rows = await query(`
    SELECT SUSER_SNAME() AS login_name,
           IS_ROLEMEMBER('db_datareader') AS can_read,
           IS_ROLEMEMBER('db_datawriter') AS can_write,
           IS_ROLEMEMBER('db_owner') AS is_db_owner,
           IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin
  `);
  console.log(rows[0]);
  process.exit(0);
})().catch((e) => { console.error("Check failed:", e.message); process.exit(1); });
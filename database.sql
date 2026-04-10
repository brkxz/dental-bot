SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS recordatorios;
DROP TABLE IF EXISTS pacientes;
DROP TABLE IF EXISTS citas;
DROP TABLE IF EXISTS vistas;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE citas (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    telefono    VARCHAR(20)  NOT NULL,
    nombre      VARCHAR(100) NOT NULL,
    dni         VARCHAR(8)   NOT NULL,
    edad        INT          NOT NULL,
    consultorio ENUM('Odontología General','Odontopediatría') NOT NULL,
    doctor      VARCHAR(100) NOT NULL,
    servicio    VARCHAR(100) NOT NULL,
    fecha       DATE         NOT NULL,
    hora        TIME         NOT NULL,
    estado      ENUM('confirmada','cancelada','completada') DEFAULT 'confirmada',
    creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_slot (fecha, hora, doctor)
);

SELECT '✅ Base de datos lista!' AS mensaje;
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title Permisos fondeados
/// @notice Quien paga deja USDC con reglas. El servicio de Permiso (operador) sólo puede liberar el monto exacto de
///         una cotización hacia la wallet de quien gasta, dentro del tope y antes del vencimiento. Lo que pase del
///         tope necesita que el aprobador ponga la diferencia. Al cerrar o vencer, lo que sobra regresa a quien pagó.
contract Permisos {
    struct Permiso {
        address pagador;      // aseguradora o marca
        address gastador;     // wallet que fondea la bóveda Kwal de quien gasta
        address aprobador;    // quien decide las excepciones
        uint256 tope;         // USDC (6 decimales) depositado
        uint256 gastado;
        uint64 vence;
        bool activo;
        bytes32 reglas;       // hash de las reglas (tiendas, categorías) guardadas fuera de la cadena
    }

    IERC20 public immutable usdc;
    address public immutable operador;
    mapping(bytes32 => Permiso) public permisos;

    event Creado(bytes32 indexed id, address pagador, address gastador, uint256 tope, uint64 vence, bytes32 reglas);
    event Autorizado(bytes32 indexed id, uint256 monto, bytes32 cotizacion, uint256 gastado);
    event Aprobado(bytes32 indexed id, uint256 extra, bytes32 cotizacion);
    event Recibo(bytes32 indexed id, bytes32 compra, bytes32 recibo);
    event Cerrado(bytes32 indexed id, uint256 sobrante);

    error NoAutorizado();
    error YaExiste();
    error Inactivo();
    error Vencido();
    error PasaDelTope(uint256 saldo, uint256 monto);
    error FalloTransferencia();

    constructor(IERC20 _usdc, address _operador) {
        usdc = _usdc;
        operador = _operador;
    }

    function crear(bytes32 id, address gastador, address aprobador, uint256 tope, uint64 vence, bytes32 reglas) external {
        if (permisos[id].pagador != address(0)) revert YaExiste();
        if (!usdc.transferFrom(msg.sender, address(this), tope)) revert FalloTransferencia();
        permisos[id] = Permiso(msg.sender, gastador, aprobador, tope, 0, vence, true, reglas);
        emit Creado(id, msg.sender, gastador, tope, vence, reglas);
    }

    /// Libera exactamente `monto` hacia quien gasta. Sólo el operador, sólo dentro del saldo y antes de vencer.
    function autorizar(bytes32 id, uint256 monto, bytes32 cotizacion) external {
        if (msg.sender != operador) revert NoAutorizado();
        Permiso storage p = permisos[id];
        if (!p.activo) revert Inactivo();
        if (block.timestamp >= p.vence) revert Vencido();
        uint256 saldo = p.tope - p.gastado;
        if (monto > saldo) revert PasaDelTope(saldo, monto);
        p.gastado += monto;
        if (!usdc.transfer(p.gastador, monto)) revert FalloTransferencia();
        emit Autorizado(id, monto, cotizacion, p.gastado);
    }

    /// El aprobador acepta una excepción poniendo la diferencia: sube el tope con fondos reales.
    function aprobar(bytes32 id, uint256 extra, bytes32 cotizacion) external {
        Permiso storage p = permisos[id];
        if (msg.sender != p.aprobador) revert NoAutorizado();
        if (!p.activo) revert Inactivo();
        if (!usdc.transferFrom(msg.sender, address(this), extra)) revert FalloTransferencia();
        p.tope += extra;
        emit Aprobado(id, extra, cotizacion);
    }

    function recibo(bytes32 id, bytes32 compra, bytes32 hashRecibo) external {
        if (msg.sender != operador) revert NoAutorizado();
        emit Recibo(id, compra, hashRecibo);
    }

    /// Cierra y devuelve el sobrante a quien pagó. Pagador u operador cuando quieran; cualquiera después de vencer.
    function cerrar(bytes32 id) external {
        Permiso storage p = permisos[id];
        if (!p.activo) revert Inactivo();
        if (msg.sender != p.pagador && msg.sender != operador && block.timestamp < p.vence) revert NoAutorizado();
        p.activo = false;
        uint256 sobrante = p.tope - p.gastado;
        if (sobrante > 0 && !usdc.transfer(p.pagador, sobrante)) revert FalloTransferencia();
        emit Cerrado(id, sobrante);
    }
}
